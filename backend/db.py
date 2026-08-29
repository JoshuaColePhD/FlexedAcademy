"""PostgreSQL persistence (Supabase, via psycopg2 + pgvector).

This module said "SQLite" until now, and pointed at config._default_db_path()
for an explanation about Google Drive and WAL sidecars. Both were left behind by
the Postgres rewrite: the database is remote, DATABASE_URL is required, and
_default_db_path() is dead code nothing calls.

Placeholders are written as `?` throughout and rewritten to `%s` by
_write/_rows/_row — so a literal `?` inside a SQL string would be corrupted.

Migrations are the MIGRATIONS list below: version == index + 1, applied in order,
recorded in schema_version. Append only — never edit or reorder an entry, since
`MIGRATIONS[version:]` is what decides what still needs running. A migration that
raises leaves its version un-recorded and replays from the top next boot, so new
DDL should be idempotent (IF NOT EXISTS / guarded backfills).
"""
from __future__ import annotations

import contextvars
import json
import logging
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg2
from pgvector.psycopg2 import register_vector
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

from . import storage
from .config import settings
from .errors import AppError

current_user_id = contextvars.ContextVar("current_user_id", default=None)

log = logging.getLogger("flexedacademy.db")

# One pool per process, opened lazily. `_conn` and the global `_lock` it was
# guarded by are gone: they made every query in the app serialise against every
# other query, across all users.
_pool: ThreadedConnectionPool | None = None
_pool_lock = threading.Lock()
# Bounds waiters so an over-subscribed pool queues instead of raising.
_slots: threading.Semaphore | None = None

MIGRATIONS: list[str] = [
    """
    CREATE TABLE settings (
      id         SERIAL PRIMARY KEY,
      teacher    TEXT NOT NULL DEFAULT 'Josh Cole',
      course     TEXT NOT NULL DEFAULT 'AP Language & Composition',
      period     TEXT NOT NULL DEFAULT '3rd period',
      updated_at TEXT NOT NULL,
      CHECK (id = 1)
    );
    CREATE TABLE chats (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE plans (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL,
      course        TEXT NOT NULL,
      week_label    TEXT NOT NULL,
      unit          TEXT,
      query         TEXT NOT NULL,
      plan_json     TEXT NOT NULL,
      docx_path     TEXT,
      retrieved_ids TEXT,
      warnings      TEXT,
      chat_id       TEXT REFERENCES chats(id) ON DELETE SET NULL,
      template      TEXT NOT NULL DEFAULT 'florence-docx-v2'
    );
    CREATE INDEX idx_plans_created ON plans(created_at DESC);
    CREATE TABLE messages (
      id         SERIAL PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content    TEXT NOT NULL,
      plan_id    TEXT REFERENCES plans(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_messages_chat ON messages(chat_id, id);
    """,
    """
    ALTER TABLE settings ADD COLUMN subject TEXT NOT NULL DEFAULT 'AP Language & Composition';
    ALTER TABLE settings ADD COLUMN grade TEXT NOT NULL DEFAULT '11';
    """,
    """
    CREATE TABLE settings_new (
      subject    TEXT PRIMARY KEY,
      teacher    TEXT NOT NULL,
      course     TEXT NOT NULL,
      period     TEXT NOT NULL,
      grade      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO settings_new (subject, teacher, course, period, grade, updated_at)
    SELECT subject, teacher, course, period, grade, updated_at FROM settings;
    DROP TABLE settings;
    ALTER TABLE settings_new RENAME TO settings;
    """,
    """
    CREATE TABLE curriculum_maps (
      id           TEXT PRIMARY KEY,
      subject      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_path  TEXT NOT NULL,
      chars        INTEGER NOT NULL DEFAULT 0,
      active       INTEGER NOT NULL DEFAULT 1,
      uploaded_at  TEXT NOT NULL
    );
    CREATE INDEX idx_curriculum_maps_subject ON curriculum_maps(subject, active);
    CREATE TABLE curriculum_progress (
      id           TEXT PRIMARY KEY,
      map_id       TEXT NOT NULL REFERENCES curriculum_maps(id) ON DELETE CASCADE,
      subject      TEXT NOT NULL,
      sort_order   INTEGER NOT NULL,
      unit         TEXT,
      week_label   TEXT,
      target_start TEXT,
      target_end   TEXT,
      standards    TEXT,
      notes        TEXT
    );
    CREATE INDEX idx_curriculum_progress_map ON curriculum_progress(map_id, sort_order);
    """,
    """
    CREATE TABLE settings_v5 (
      user_id    TEXT NOT NULL,
      subject    TEXT NOT NULL,
      teacher    TEXT NOT NULL,
      course     TEXT NOT NULL,
      period     TEXT NOT NULL,
      grade      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, subject)
    );
    INSERT INTO settings_v5 (user_id, subject, teacher, course, period, grade, updated_at)
    SELECT 'default_user', subject, teacher, course, period, grade, updated_at FROM settings;
    DROP TABLE settings;
    ALTER TABLE settings_v5 RENAME TO settings;
    ALTER TABLE chats ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    ALTER TABLE plans ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    """,
    """
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT,
      created_at    TEXT NOT NULL
    );
    INSERT INTO users (id, email, name, password_hash, created_at)
    VALUES ('default_user', 'jpcole@florencek12.org', 'Josh Cole', NULL, '2024-01-01T00:00:00+00:00');
    ALTER TABLE curriculum_maps ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    ALTER TABLE curriculum_progress ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default_user';
    CREATE INDEX idx_curriculum_maps_user ON curriculum_maps(user_id, subject, active);
    CREATE INDEX idx_curriculum_progress_user ON curriculum_progress(user_id, subject);
    CREATE INDEX idx_chats_user ON chats(user_id);
    CREATE INDEX idx_plans_user ON plans(user_id);
    """,
    """
    CREATE TABLE plan_feedback (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      is_good    INTEGER NOT NULL CHECK(is_good IN (0, 1)),
      notes      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_plan_feedback_plan ON plan_feedback(plan_id);
    """,
    """
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE chunks (
      id          TEXT PRIMARY KEY,
      document    TEXT NOT NULL,
      metadata    JSONB,
      embedding   vector(384)
    );
    CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
    """,
    # ── 9: classes ───────────────────────────────────────────────────────────
    # A teacher has several preps. Until now the only thing standing in for that
    # was settings' (user_id, subject) primary key, which meant "one class per
    # standards framework" — so ENG 101 and ENG 102, both ELA, silently
    # overwrote each other, and the teacher's name had to be re-typed into every
    # row. Classes are now first-class:
    #
    #   * the teacher's name moves to users.name, asked once for the whole app
    #   * plans and chats point at the class they belong to, so Recent can be
    #     filtered instead of mixing every prep into one list
    #   * curriculum_maps hang off a class rather than a framework, and gain a
    #     `kind` so one class can hold a pacing guide AND a syllabus AND a map
    #
    # Written to be re-runnable: a migration that raises leaves its version
    # un-inserted and replays from the top on the next boot, so every statement
    # here is IF NOT EXISTS or an idempotent backfill.
    """
    CREATE TABLE IF NOT EXISTS classes (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      subject    TEXT NOT NULL,
      grade      TEXT NOT NULL,
      state      TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_classes_user ON classes(user_id, archived, sort_order);
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS state TEXT;

    ALTER TABLE plans           ADD COLUMN IF NOT EXISTS class_id TEXT REFERENCES classes(id) ON DELETE SET NULL;
    ALTER TABLE chats           ADD COLUMN IF NOT EXISTS class_id TEXT REFERENCES classes(id) ON DELETE SET NULL;
    ALTER TABLE curriculum_maps ADD COLUMN IF NOT EXISTS class_id TEXT REFERENCES classes(id) ON DELETE CASCADE;
    ALTER TABLE curriculum_maps ADD COLUMN IF NOT EXISTS kind     TEXT NOT NULL DEFAULT 'pacing_guide';

    CREATE INDEX IF NOT EXISTS idx_plans_class ON plans(class_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_class ON chats(class_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_curriculum_maps_class ON curriculum_maps(class_id, active);

    -- One class per existing settings row, which is exactly what those rows
    -- already were. settings.course is the display name the teacher typed, so
    -- it carries over as the class name.
    INSERT INTO classes (id, user_id, name, subject, grade, sort_order, archived, created_at)
    SELECT md5(s.user_id || ':' || s.subject), s.user_id, s.course, s.subject, s.grade, 0, 0, s.updated_at
    FROM settings s
    WHERE NOT EXISTS (SELECT 1 FROM classes c WHERE c.id = md5(s.user_id || ':' || s.subject));

    -- Adopt existing rows. plans.course is a free-text display string copied
    -- from settings.course, which is the only handle available — there was
    -- never a key. Anything that doesn't match stays NULL rather than being
    -- guessed into the wrong class.
    UPDATE plans p SET class_id = c.id
      FROM classes c
     WHERE p.class_id IS NULL AND c.user_id = p.user_id AND c.name = p.course;

    UPDATE curriculum_maps m SET class_id = c.id
      FROM classes c
     WHERE m.class_id IS NULL AND c.user_id = m.user_id AND c.subject = m.subject;

    -- Seed users.name from the teacher name that was being repeated per row.
    UPDATE users u SET name = s.teacher
      FROM (SELECT DISTINCT ON (user_id) user_id, teacher FROM settings ORDER BY user_id, updated_at DESC) s
     WHERE u.id = s.user_id AND COALESCE(NULLIF(TRIM(s.teacher), ''), NULL) IS NOT NULL;
    """,
    # ── 10: curriculum map chunks in pgvector ────────────────────────────────
    # These lived in a Chroma collection embedded with all-MiniLM-L6-v2, which
    # meant carrying chromadb + torch purely for pacing-guide lookup — and it
    # never actually ran: settings.chroma_path was referenced but never declared,
    # so every embed raised AttributeError behind a bare `except` and
    # retrieve_map_context silently returned "". The pacing guide has therefore
    # never once reached the generation prompt.
    #
    # Same 384-dim space as `chunks`, so one embedding model serves both.
    """
    CREATE TABLE IF NOT EXISTS curriculum_chunks (
      id          TEXT PRIMARY KEY,
      map_id      TEXT NOT NULL REFERENCES curriculum_maps(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      document    TEXT NOT NULL,
      embedding   vector(384)
    );
    CREATE INDEX IF NOT EXISTS idx_curriculum_chunks_map ON curriculum_chunks(map_id, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_curriculum_chunks_vec
      ON curriculum_chunks USING hnsw (embedding vector_cosine_ops);
    """,
    # ── 11: a plan knows which week it is ────────────────────────────────────
    # week_board joined plans to weeks by PARSING WHAT THE MODEL WROTE —
    # units.week_number(plans.week_label), where week_label is free text the LLM
    # emitted into `week_of`. That was tolerable while the board was a read-only
    # list. It is not tolerable now that the week number is a URL: /week/12
    # resolving to the right plan would depend on the model having chosen to
    # write "Week 12 — ..." rather than "the week of October 19".
    #
    # The backfill uses the same regex units.week_number does, so nothing that
    # currently resolves stops resolving. Rows whose label never parsed stay
    # NULL — they were already invisible to the board, and guessing a week for
    # them would put a plan on a date nobody chose.
    """
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS week_number INTEGER;

    UPDATE plans
       SET week_number = NULLIF(substring(week_label FROM '(?i)week\\s*0*(\\d{1,2})'), '')::int
     WHERE week_number IS NULL
       AND week_label ~* 'week\\s*0*\\d{1,2}';

    CREATE INDEX IF NOT EXISTS idx_plans_week
      ON plans(user_id, class_id, week_number);
    """,
    # ── 12: close the public REST API ────────────────────────────────────────
    # Supabase exposes the `public` schema to PostgREST, so with RLS off anyone
    # holding the project's anon key — which Supabase treats as public by
    # design, and which is meant to ship in frontend code — could read and write
    # users, plans, chats and messages directly, over the internet, with no
    # login. Supabase's own security advisor flagged all twelve tables as ERROR.
    #
    # This was first applied by hand. It is a migration now because a database
    # that starts insecure and depends on someone remembering to lock it is a
    # database that will eventually be left unlocked — and the app has already
    # been rebuilt on a fresh project once.
    #
    # The app is unaffected: it connects over the pooler as `postgres`, which
    # has BYPASSRLS. Deliberately NO policies — a policy would be a way in, and
    # there is no legitimate caller here that isn't already bypassing RLS.
    """
    ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
    ALTER TABLE classes             ENABLE ROW LEVEL SECURITY;
    ALTER TABLE settings            ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chats               ENABLE ROW LEVEL SECURITY;
    ALTER TABLE messages            ENABLE ROW LEVEL SECURITY;
    ALTER TABLE plans               ENABLE ROW LEVEL SECURITY;
    ALTER TABLE plan_feedback       ENABLE ROW LEVEL SECURITY;
    ALTER TABLE curriculum_maps     ENABLE ROW LEVEL SECURITY;
    ALTER TABLE curriculum_progress ENABLE ROW LEVEL SECURITY;
    ALTER TABLE curriculum_chunks   ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chunks              ENABLE ROW LEVEL SECURITY;
    ALTER TABLE schema_version      ENABLE ROW LEVEL SECURITY;
    """,
    # ── 13: hybrid search tsvector ───────────────────────────────────────────
    """
    ALTER TABLE chunks ADD COLUMN IF NOT EXISTS document_tsvector tsvector GENERATED ALWAYS AS (to_tsvector('english', document)) STORED;
    CREATE INDEX IF NOT EXISTS idx_chunks_tsvector ON chunks USING GIN (document_tsvector);
    """,
    # ── 14: attribute existing chats to a class ──────────────────────────────
    #
    # chats.class_id has existed since migration 9 and was never written, so
    # every chat is NULL and the sidebar shows every prep's conversations under
    # all of them — a teacher with AP Lang and AP Physics 1 sees one undivided
    # list relabelled to whichever class they happen to be in.
    #
    # A chat's plans DO know their class, so most of the history can be
    # recovered rather than guessed. Whatever is left (a chat that never
    # produced a plan) stays NULL on purpose: list_chats treats NULL as
    # "belongs to no class in particular" and shows it everywhere, which is
    # exactly today's behaviour. Nothing disappears from anyone's sidebar
    # because of this migration.
    #
    # Idempotent: only touches rows that are still NULL, so a replay after a
    # failed deploy is a no-op.
    """
    UPDATE chats SET class_id = (
        SELECT p.class_id FROM plans p
         WHERE p.chat_id = chats.id AND p.class_id IS NOT NULL
         ORDER BY p.created_at DESC
         LIMIT 1
    )
    WHERE class_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_chats_user_class ON chats(user_id, class_id);
    """,
    # ── 15: subscriptions ────────────────────────────────────────────────────
    #
    # One week of plans free, then a subscription. The count of free weeks used
    # is COUNT(plans) — deliberately not a counter column, because a counter is
    # a second source of truth that can drift from the thing it counts, and the
    # plans are the thing being sold.
    #
    # `status` mirrors Stripe's subscription status ('active', 'trialing',
    # 'past_due', 'canceled', …) plus one of our own, 'comped'.
    #
    # EVERY EXISTING ACCOUNT IS COMPED. They signed up when the app was free and
    # some already hold more plans than the free allowance, so any other
    # default would lock them out of work they had already done the moment this
    # deployed. Comped is permanent and free; it is not a trial.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_period_end TEXT;
    UPDATE users SET subscription_status = 'comped' WHERE subscription_status IS NULL;
    CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
    """,
    # ── 16: admin ────────────────────────────────────────────────────────────
    # Managing accounts by hand-written SQL against production doesn't scale
    # past "the one person building this app". is_admin gates a real in-app
    # page instead. Seeded onto the two accounts that exist today; every
    # account after this migration starts as a normal (non-admin) teacher.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    UPDATE users SET is_admin = true
      WHERE email IN ('joshuacolephd@gmail.com', 'jpcole@florencek12.org');
    """,
    # ── 17: usage-based free tier ────────────────────────────────────────────
    #
    # Replaces "one free plan, ever" (migration 15). That gated on plan COUNT,
    # so a teacher who revised the same week fifteen times paid nothing extra
    # while one who built two short weeks was locked out — the thing actually
    # being protected (API spend) was never what was being measured.
    #
    # This measures it directly: every model call this app makes records its
    # real input/output tokens here (db.record_usage), and entitlement.py sums
    # the trailing 7 days of them against a weekly cap instead of counting
    # plans. One row per call, not a running counter column, for the same
    # reason migration 15 counted plans instead of a counter — a sum over the
    # actual events can't drift from what it's summing.
    """
    CREATE TABLE IF NOT EXISTS usage_events (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        kind       TEXT NOT NULL,
        tokens_in  INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_time ON usage_events(user_id, created_at);
    ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
    """,
    # ── 18: sign out of all devices ──────────────────────────────────────────
    #
    # Sessions are a stateless signed cookie (auth.py) — {uid, exp}, HMAC'd,
    # nothing stored server-side. That means there was no way to revoke ONE
    # account's sessions short of rotating settings.session_secret, which
    # invalidates every account's at once (see auth.py's own header comment).
    #
    # This column, embedded in every new token as "sv" and checked against the
    # account's CURRENT value on every request (deps.get_current_user), is
    # what makes a per-account revocation possible without a sessions table to
    # garbage-collect: "sign out everywhere" is just incrementing this one
    # integer, which is enough to make every previously-issued cookie for that
    # account fail the comparison on its very next use. Same idiom this file
    # already uses for password-reset tokens (auth._password_fingerprint) —
    # sign a value, recheck it against current DB state at redemption time.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
    """,
    # ── 19: global custom instructions ───────────────────────────────────────
    #
    # Like Claude's own custom instructions: free text written once, applied
    # to every generation and every chat — not per-class. `settings` is keyed
    # by (user_id, subject), so a value there would need to be kept in sync
    # across every subject a teacher teaches, the exact bug this feature
    # would otherwise introduce. `users` is genuinely one row per account.
    #
    # Spliced into prompts.py's system prompts AFTER grounding_constraints(),
    # never before — that function's own text already says it "override[s]
    # everything else, including the teacher's request," and text order is
    # what makes that override apply to this too.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_instructions TEXT;
    """,
    # ── 20: Row Level Security ───────────────────────────────────────────────
    #
    # Enable RLS on all tenant-specific tables to satisfy Supabase security
    # recommendations and provide defense-in-depth.
    """
    ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
    ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
    ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE curriculum_maps ENABLE ROW LEVEL SECURITY;
    ALTER TABLE plan_feedback ENABLE ROW LEVEL SECURITY;

    -- One DO block PER POLICY, not six in one.
    --
    -- They were all in a single block, and the `messages` one referenced a
    -- user_id column that table has never had (a message is scoped through
    -- its chat — see the CREATE TABLE above). That one bad statement aborted
    -- the whole block, so NONE of the six policies were ever created, while
    -- the ENABLE ROW LEVEL SECURITY statements above had already committed.
    -- RLS on with zero policies means "deny every row" for anyone who is not
    -- the table owner: invisible while the app connects as the owner, and a
    -- total blackout the moment anything else does (a restricted app role,
    -- PostgREST, the Supabase dashboard). The migration also never recorded
    -- as applied, so it re-ran and re-failed on every single boot.
    --
    -- Per-policy blocks mean one wrong column can only cost its own policy
    -- from here on, instead of silently disarming the other five.
    DO $$ BEGIN
        CREATE POLICY "Users can access their own classes" ON classes USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own chats" ON chats USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own plans" ON plans USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    -- Through chats, because `messages` has no user_id of its own.
    DO $$ BEGIN
        CREATE POLICY "Users can access their own messages" ON messages USING (
            chat_id IN (SELECT id FROM chats WHERE user_id = current_setting('app.user_id', true))
        );
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own maps" ON curriculum_maps USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own feedback" ON plan_feedback USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    """,
    # ── 21: LLM Caching ───────────────────────────────────────────────────────
    #
    # Exact-match caching for LLM calls to save tokens and reduce latency.
    """
    CREATE TABLE IF NOT EXISTS llm_cache (
        hash_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        response TEXT NOT NULL
    );
    """,
    # ── 22: school ────────────────────────────────────────────────────────────
    #
    # Groundwork, not a working multi-template switch yet: there is exactly
    # one docx builder (backend/builder/build_lesson_plan.py, hardcoded to
    # Florence's own layout — see docx_build.builder_template()'s
    # florence-docx-v2 check), so this column exists to be shown back on the
    # settings page and to give a second school somewhere real to land when
    # one actually gets a builder of its own. Plain TEXT, not an enum/FK to a
    # schools table — there's only one real value today, and a fixed enum
    # would need its own migration the day a second school shows up anyway.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS school TEXT NOT NULL DEFAULT 'florence-high-school';
    """,
    # ── 23: schools ──────────────────────────────────────────────────────────
    #
    # Turns migration 22's single hardcoded dict entry into a real, curated
    # list: onboarding and the admin page both read this table now, not a
    # module constant. `id` doubles as the calendar filename
    # (backend/context/calendars/<id>.md) rather than carrying a separate
    # path column — one string to keep in sync instead of two that can drift
    # apart. Seeded with the school that already exists, so users.school's
    # own default keeps resolving to a real row.
    #
    # RLS enabled with no policies, matching chunks/curriculum_progress/
    # settings above: this is public reference data (every teacher reads the
    # same rows), but Supabase's security advisor flags RLS-OFF on ANY public
    # table at ERROR severity regardless of whether the data is tenant-scoped
    # — RLS-on-with-no-policy is only ever an INFO note. The app's own DB
    # role already bypasses RLS (see migration 12), so no policy is needed
    # for the app itself to keep working.
    """
    CREATE TABLE IF NOT EXISTS schools (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    ALTER TABLE schools ENABLE ROW LEVEL SECURITY;

    INSERT INTO schools (id, name, created_at)
    VALUES ('florence-high-school', 'Florence High School', '2026-08-12T00:00:00+00:00')
    ON CONFLICT (id) DO NOTHING;
    """,
    # ── 24: a chat knows which week it is about ───────────────────────────────
    #
    # The week used to be DERIVED on every render, frontend-side, as
    # firstUnplanned(calendar) — so it drifted. The moment a conversation
    # actually built week 3, week 3 had a plan, and the same expression
    # started answering "week 4" for the very chat still discussing week 3.
    #
    # That drift is why ChatPage sent week_number on a chat's FIRST message
    # and deliberately never again: sending the drifted value would have
    # named the wrong week. The cost was that generate.py's own
    # "THE TEACHER IS CURRENTLY WORKING ON …" block (plus its pacing-guide
    # unit lookup) only ever reached the model once per conversation, then
    # went silent for every turn after.
    #
    # Pinned here instead: written once when the chat is created, never
    # recomputed, so "which week is this conversation about" has one stable
    # answer for the life of the chat — for the prompt and for the teacher.
    # Nullable with no default on purpose: chats predating this column have
    # no honest value to backfill (their calendar has moved on), and a wrong
    # week in the prompt is worse than none.
    """
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS week_number INTEGER;
    """,
    # ── 25: a class can follow its own school's calendar ───────────────────────
    #
    # school used to live only on `users` (migration 22) — one calendar for
    # the whole account, no matter how many classes are on it. That's correct
    # for a teacher whose classes are all in the same building, and silently
    # wrong for one whose aren't: a second class at a second school read the
    # first school's teaching days and closures, because there was nowhere
    # else for it to come from.
    #
    # Nullable, no default — see class_school()'s own comment for why a class
    # predating this column falls back to the account default rather than
    # getting backfilled to a value that might be wrong for it specifically.
    # create_class() DOES stamp new classes with a real value (the account's
    # CURRENT default, at creation) so a fresh class has an honest answer from
    # the start and can still be moved to a different school independently
    # later — the same "snapshot now, editable after" shape subject/grade
    # already have per class.
    """
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS school TEXT;
    """,
    # ── 26: quizzes ──────────────────────────────────────────────────────────
    #
    # One or more quizzes CAN exist per plan (a teacher can ask for a second
    # variant, or a different mix of question types, for the same week), so
    # this is its own table rather than a column on plans — a plan has many
    # quizzes, never the reverse. ON DELETE CASCADE: a quiz with no plan to
    # belong to is not a real row, it is an orphaned file on disk.
    #
    # question_types is stored as-requested (a JSON array, "make me a
    # multiple choice and matching quiz" -> ["multiple_choice","matching"])
    # rather than derived from the questions themselves, so the library can
    # show what was ASKED for even before the qti_path exists.
    """
    CREATE TABLE IF NOT EXISTS quizzes (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id        TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        question_types TEXT NOT NULL,
        quiz_json      TEXT NOT NULL,
        qti_path       TEXT,
        warnings       TEXT,
        created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quizzes_plan ON quizzes(plan_id);
    ALTER TABLE quizzes ENABLE ROW LEVEL SECURITY;
    """,
    # ── 28: school template onboarding ───────────────────────────────────────
    #
    # Tracks whether a school has an active docx_builder template or is still
    # waiting for an admin to implement it.
    """
    ALTER TABLE schools ADD COLUMN IF NOT EXISTS template_status TEXT NOT NULL DEFAULT 'active';

    CREATE TABLE IF NOT EXISTS school_templates (
        id          TEXT PRIMARY KEY,
        school_id   TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
        filename    TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        created_at  TEXT NOT NULL
    );
    ALTER TABLE school_templates ENABLE ROW LEVEL SECURITY;
    """,
    # ── 29: share a plan as a Google Doc ─────────────────────────────────────
    #
    # google_drive_tokens is its own table, not columns on users — a token has
    # a lifecycle (refreshed, revoked) that has nothing to do with the rest of
    # the account, and a NULL access_token/refresh_token pair on every teacher
    # who's never shared anything is worse than a table that's simply empty
    # for them. One row per user: the app only ever needs the one grant.
    #
    # plans.drive_file_id/drive_web_link: which Google Doc (if any) a plan has
    # already been exported to, so sharing the same plan with a second person
    # reuses that Doc instead of minting a new one every click.
    #
    # plan_shares is a log, not state anything reads back to decide access —
    # Google's own Drive permission is what actually controls who can open the
    # Doc. This exists so the share dialog can say "already shared with
    # ms.jones@…" instead of a teacher re-typing an email with no memory of
    # having done it before.
    """
    CREATE TABLE IF NOT EXISTS google_drive_tokens (
        user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        scope         TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );
    ALTER TABLE google_drive_tokens ENABLE ROW LEVEL SECURITY;

    ALTER TABLE plans ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS drive_web_link TEXT;

    CREATE TABLE IF NOT EXISTS plan_shares (
        id         TEXT PRIMARY KEY,
        plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        email      TEXT NOT NULL,
        role       TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_shares_plan ON plan_shares(plan_id);
    ALTER TABLE plan_shares ENABLE ROW LEVEL SECURITY;
    """,
    # ── 28: a per-account cap override ───────────────────────────────────────
    #
    # Before this, an account's weekly token cap was one of exactly two
    # values — the free tier's or the subscriber tier's (config.py) — with
    # "comped" (unlimited) as the only way to give any ONE account something
    # different. That's a real gap for an admin: no way to give a specific
    # teacher extra headroom without going all the way to unlimited, and no
    # way to throttle a specific account down without suspending it outright.
    #
    # Nullable, no default: NULL means "use the tier's own cap" (the existing
    # behavior for every account today, unaffected by this migration).
    # entitlement.py checks this FIRST and only falls back to the tier cap
    # when it's unset — see its own comment.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_weekly_token_cap INTEGER;
    """,
    # ── 29: cited standards, queryable per plan/class ────────────────────────
    #
    # Until now, which standards a plan actually cites lived in two
    # unstructured places: plans.retrieved_ids (what retrieval SUPPLIED, not
    # necessarily what got cited) and free-text days[].standards/
    # act_alignment strings inside plan_json, regex-parsed on demand
    # (retrieval.cited_standards/audit_grounding). There was no way to ask
    # "which standards has this class actually been taught" without
    # re-parsing every plan's plan_json by hand.
    #
    # One row per (plan, day, field, code) citation. Replaced wholesale on
    # every generation and revision (db.replace_plan_standards) rather than
    # appended to, so a plan's rows are always a snapshot of its CURRENT
    # plan_json — a rewritten day that drops a code doesn't leave a stale row
    # behind still claiming the plan cites it.
    """
    CREATE TABLE IF NOT EXISTS plan_standards (
      id         SERIAL PRIMARY KEY,
      plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      class_id   TEXT REFERENCES classes(id) ON DELETE SET NULL,
      subject    TEXT,
      grade      TEXT,
      day_index  INTEGER NOT NULL,
      day_name   TEXT NOT NULL,
      field      TEXT NOT NULL,
      code       TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('grounded', 'not_retrieved', 'wrong_course', 'hallucinated')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_standards_plan ON plan_standards(plan_id);
    CREATE INDEX IF NOT EXISTS idx_plan_standards_class_code ON plan_standards(class_id, code);
    CREATE INDEX IF NOT EXISTS idx_plan_standards_code ON plan_standards(code);
    -- Partial: the overwhelming majority of rows are 'grounded' and never
    -- worth a full-table index scan for — this only ever needs to be fast
    -- for "show me what needs attention".
    CREATE INDEX IF NOT EXISTS idx_plan_standards_flagged ON plan_standards(status) WHERE status != 'grounded';
    ALTER TABLE plan_standards ENABLE ROW LEVEL SECURITY;
    DO $$ BEGIN
        CREATE POLICY "Users can access their own cited standards" ON plan_standards USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    """,
    # Teacher-uploaded calendars, pending a second teacher's confirmation
    # before schoolcal.py will treat them as real — see schoolcal.py's own
    # comment on why hand-curated files stay the norm and this is additive,
    # not a replacement.
    """
    CREATE TABLE IF NOT EXISTS school_calendar_submissions (
      id            TEXT PRIMARY KEY,
      school_id     TEXT NOT NULL,
      submitted_by  TEXT NOT NULL,
      submitted_at  TEXT NOT NULL,
      source_kind   TEXT NOT NULL,
      source_name   TEXT,
      weeks         JSONB NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
      confirmed_by  TEXT,
      confirmed_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_submissions_school_status ON school_calendar_submissions(school_id, status);
    ALTER TABLE school_calendar_submissions ENABLE ROW LEVEL SECURITY;
    """,

    # ── 31: Alabama public high schools ──────────────────────────────────────
    #
    # Turns the "My school isn't listed yet" fallback (migration 23's
    # florence-high-school being the only real row) into an actual choice for
    # almost every Alabama teacher, not just the one at Florence: every
    # public high school pulled from Wikipedia's "List of high schools in
    # Alabama", name only -- same shape florence-high-school already has, no
    # calendar attached (that still comes from a teacher's own upload, see
    # migration 30's school_calendar_submissions). A handful of names collide
    # across counties (several "Central High School"s, two "Carver High
    # School"s, etc.) -- those carry a city in parentheses so the picker can
    # tell them apart; every other name is exactly as the source lists it.
    # This is a best-effort transcription of a community-maintained list, not
    # an official state roster -- a wrong or missing entry is expected and
    # correctable later (delete_school/create_school, already wired to the
    # admin page), not a reason to hold off shipping the other ~300.
    """
    INSERT INTO schools (id, name, created_at) VALUES
      ('a-h-parker-high-school', 'A. H. Parker High School', '2026-08-17T00:00:00+00:00'),
      ('abbeville-high-school', 'Abbeville High School', '2026-08-17T00:00:00+00:00'),
      ('alabama-school-of-cyber-technology-and-engineering', 'Alabama School of Cyber Technology and Engineering', '2026-08-17T00:00:00+00:00'),
      ('alabama-school-of-fine-arts', 'Alabama School of Fine Arts', '2026-08-17T00:00:00+00:00'),
      ('alabaster-high-school', 'Alabaster High School', '2026-08-17T00:00:00+00:00'),
      ('albertville-high-school', 'Albertville High School', '2026-08-17T00:00:00+00:00'),
      ('alexander-city-high-school', 'Alexander City High School', '2026-08-17T00:00:00+00:00'),
      ('alexandria-high-school', 'Alexandria High School', '2026-08-17T00:00:00+00:00'),
      ('aliceville-high-school', 'Aliceville High School', '2026-08-17T00:00:00+00:00'),
      ('alma-bryant-high-school', 'Alma Bryant High School', '2026-08-17T00:00:00+00:00'),
      ('amelia-love-johnson-high-school', 'Amelia Love Johnson High School', '2026-08-17T00:00:00+00:00'),
      ('andalusia-high-school', 'Andalusia High School', '2026-08-17T00:00:00+00:00'),
      ('anniston-high-school', 'Anniston High School', '2026-08-17T00:00:00+00:00'),
      ('appalachian-school', 'Appalachian School', '2026-08-17T00:00:00+00:00'),
      ('arab-high-school', 'Arab High School', '2026-08-17T00:00:00+00:00'),
      ('ardmore-high-school', 'Ardmore High School', '2026-08-17T00:00:00+00:00'),
      ('ariton-school', 'Ariton School', '2026-08-17T00:00:00+00:00'),
      ('asbury-high-school', 'Asbury High School', '2026-08-17T00:00:00+00:00'),
      ('ashford-high-school', 'Ashford High School', '2026-08-17T00:00:00+00:00'),
      ('athens-high-school', 'Athens High School', '2026-08-17T00:00:00+00:00'),
      ('auburn-high-school', 'Auburn High School', '2026-08-17T00:00:00+00:00'),
      ('baldwin-county-high-school', 'Baldwin County High School', '2026-08-17T00:00:00+00:00'),
      ('barbour-county-high-school', 'Barbour County High School', '2026-08-17T00:00:00+00:00'),
      ('beauregard-high-school', 'Beauregard High School', '2026-08-17T00:00:00+00:00'),
      ('belgreen-high-school', 'Belgreen High School', '2026-08-17T00:00:00+00:00'),
      ('berry-high-school', 'Berry High School', '2026-08-17T00:00:00+00:00'),
      ('bessemer-city-high-school', 'Bessemer City High School', '2026-08-17T00:00:00+00:00'),
      ('beulah-high-school', 'Beulah High School', '2026-08-17T00:00:00+00:00'),
      ('bibb-county-high-school', 'Bibb County High School', '2026-08-17T00:00:00+00:00'),
      ('billingsley-high-school', 'Billingsley High School', '2026-08-17T00:00:00+00:00'),
      ('blount-high-school-mobile', 'Blount High School (Mobile)', '2026-08-17T00:00:00+00:00'),
      ('boaz-high-school', 'Boaz High School', '2026-08-17T00:00:00+00:00'),
      ('bob-jones-high-school', 'Bob Jones High School', '2026-08-17T00:00:00+00:00'),
      ('booker-t-washington-high-school-montgomery', 'Booker T. Washington High School (Montgomery)', '2026-08-17T00:00:00+00:00'),
      ('booker-t-washington-high-school-tuskegee', 'Booker T. Washington High School (Tuskegee)', '2026-08-17T00:00:00+00:00'),
      ('brantley-high-school', 'Brantley High School', '2026-08-17T00:00:00+00:00'),
      ('brilliant-high-school', 'Brilliant High School', '2026-08-17T00:00:00+00:00'),
      ('brindlee-mountain-high-school', 'Brindlee Mountain High School', '2026-08-17T00:00:00+00:00'),
      ('brooks-high-school', 'Brooks High School', '2026-08-17T00:00:00+00:00'),
      ('buckhorn-high-school', 'Buckhorn High School', '2026-08-17T00:00:00+00:00'),
      ('bullock-county-high-school', 'Bullock County High School', '2026-08-17T00:00:00+00:00'),
      ('calhoun-high-school', 'Calhoun High School', '2026-08-17T00:00:00+00:00'),
      ('camp-hill-high-school', 'Camp Hill High School', '2026-08-17T00:00:00+00:00'),
      ('carroll-high-school', 'Carroll High School', '2026-08-17T00:00:00+00:00'),
      ('carver-high-school-birmingham', 'Carver High School (Birmingham)', '2026-08-17T00:00:00+00:00'),
      ('carver-high-school-montgomery', 'Carver High School (Montgomery)', '2026-08-17T00:00:00+00:00'),
      ('cedar-bluff-school', 'Cedar Bluff School', '2026-08-17T00:00:00+00:00'),
      ('center-point-high-school', 'Center Point High School', '2026-08-17T00:00:00+00:00'),
      ('central-high-school-florence', 'Central High School (Florence)', '2026-08-17T00:00:00+00:00'),
      ('central-high-school-hayneville', 'Central High School (Hayneville)', '2026-08-17T00:00:00+00:00'),
      ('central-high-school-rockford', 'Central High School (Rockford)', '2026-08-17T00:00:00+00:00'),
      ('central-high-school-tuscaloosa', 'Central High School (Tuscaloosa)', '2026-08-17T00:00:00+00:00'),
      ('central-high-school-of-clay-county', 'Central High School of Clay County', '2026-08-17T00:00:00+00:00'),
      ('charles-henderson-high-school', 'Charles Henderson High School', '2026-08-17T00:00:00+00:00'),
      ('cherokee-county-high-school', 'Cherokee County High School', '2026-08-17T00:00:00+00:00'),
      ('cherokee-high-school', 'Cherokee High School', '2026-08-17T00:00:00+00:00'),
      ('chickasaw-city-high-school', 'Chickasaw City High School', '2026-08-17T00:00:00+00:00'),
      ('chilton-county-high-school', 'Chilton County High School', '2026-08-17T00:00:00+00:00'),
      ('choctaw-county-high-school', 'Choctaw County High School', '2026-08-17T00:00:00+00:00'),
      ('citronelle-high-school', 'Citronelle High School', '2026-08-17T00:00:00+00:00'),
      ('clarke-county-high-school', 'Clarke County High School', '2026-08-17T00:00:00+00:00'),
      ('clay-chalkville-high-school', 'Clay-Chalkville High School', '2026-08-17T00:00:00+00:00'),
      ('cleburne-county-high-school', 'Cleburne County High School', '2026-08-17T00:00:00+00:00'),
      ('clements-high-school', 'Clements High School', '2026-08-17T00:00:00+00:00'),
      ('cleveland-high-school', 'Cleveland High School', '2026-08-17T00:00:00+00:00'),
      ('colbert-county-high-school', 'Colbert County High School', '2026-08-17T00:00:00+00:00'),
      ('colbert-heights-high-school', 'Colbert Heights High School', '2026-08-17T00:00:00+00:00'),
      ('cold-springs-high-school', 'Cold Springs High School', '2026-08-17T00:00:00+00:00'),
      ('collinsville-high-school', 'Collinsville High School', '2026-08-17T00:00:00+00:00'),
      ('columbia-high-school', 'Columbia High School', '2026-08-17T00:00:00+00:00'),
      ('columbiana-high-school', 'Columbiana High School', '2026-08-17T00:00:00+00:00'),
      ('corner-high-school', 'Corner High School', '2026-08-17T00:00:00+00:00'),
      ('cottonwood-high-school', 'Cottonwood High School', '2026-08-17T00:00:00+00:00'),
      ('crossville-high-school', 'Crossville High School', '2026-08-17T00:00:00+00:00'),
      ('cullman-high-school', 'Cullman High School', '2026-08-17T00:00:00+00:00'),
      ('dale-county-high-school', 'Dale County High School', '2026-08-17T00:00:00+00:00'),
      ('daleville-high-school', 'Daleville High School', '2026-08-17T00:00:00+00:00'),
      ('dallas-county-high-school', 'Dallas County High School', '2026-08-17T00:00:00+00:00'),
      ('daphne-high-school', 'Daphne High School', '2026-08-17T00:00:00+00:00'),
      ('decatur-high-school', 'Decatur High School', '2026-08-17T00:00:00+00:00'),
      ('demopolis-high-school', 'Demopolis High School', '2026-08-17T00:00:00+00:00'),
      ('deshler-high-school', 'Deshler High School', '2026-08-17T00:00:00+00:00'),
      ('dothan-high-school', 'Dothan High School', '2026-08-17T00:00:00+00:00'),
      ('douglas-high-school', 'Douglas High School', '2026-08-17T00:00:00+00:00'),
      ('east-lawrence-high-school', 'East Lawrence High School', '2026-08-17T00:00:00+00:00'),
      ('east-limestone-high-school', 'East Limestone High School', '2026-08-17T00:00:00+00:00'),
      ('eastchase-high-school', 'Eastchase High School', '2026-08-17T00:00:00+00:00'),
      ('elba-high-school', 'Elba High School', '2026-08-17T00:00:00+00:00'),
      ('elkmont-high-school', 'Elkmont High School', '2026-08-17T00:00:00+00:00'),
      ('elmore-county-high-school', 'Elmore County High School', '2026-08-17T00:00:00+00:00'),
      ('enterprise-high-school', 'Enterprise High School', '2026-08-17T00:00:00+00:00'),
      ('escambia-county-high-school', 'Escambia County High School', '2026-08-17T00:00:00+00:00'),
      ('etowah-high-school', 'Etowah High School', '2026-08-17T00:00:00+00:00'),
      ('eufaula-high-school', 'Eufaula High School', '2026-08-17T00:00:00+00:00'),
      ('fairfield-high-preparatory-school', 'Fairfield High Preparatory School', '2026-08-17T00:00:00+00:00'),
      ('fairhope-high-school', 'Fairhope High School', '2026-08-17T00:00:00+00:00'),
      ('fairview-high-school', 'Fairview High School', '2026-08-17T00:00:00+00:00'),
      ('fayette-county-high-school', 'Fayette County High School', '2026-08-17T00:00:00+00:00'),
      ('flomaton-high-school', 'Flomaton High School', '2026-08-17T00:00:00+00:00'),
      ('florala-high-school', 'Florala High School', '2026-08-17T00:00:00+00:00'),
      ('foley-high-school', 'Foley High School', '2026-08-17T00:00:00+00:00'),
      ('fort-payne-high-school', 'Fort Payne High School', '2026-08-17T00:00:00+00:00'),
      ('fultondale-high-school', 'Fultondale High School', '2026-08-17T00:00:00+00:00'),
      ('fyffe-high-school', 'Fyffe High School', '2026-08-17T00:00:00+00:00'),
      ('g-w-long-high-school', 'G. W. Long High School', '2026-08-17T00:00:00+00:00'),
      ('gadsden-city-high-school', 'Gadsden City High School', '2026-08-17T00:00:00+00:00'),
      ('gardendale-high-school', 'Gardendale High School', '2026-08-17T00:00:00+00:00'),
      ('gaston-high-school', 'Gaston High School', '2026-08-17T00:00:00+00:00'),
      ('gaylesville-school', 'Gaylesville School', '2026-08-17T00:00:00+00:00'),
      ('geneva-county-high-school', 'Geneva County High School', '2026-08-17T00:00:00+00:00'),
      ('geneva-high-school', 'Geneva High School', '2026-08-17T00:00:00+00:00'),
      ('georgiana-school', 'Georgiana School', '2026-08-17T00:00:00+00:00'),
      ('geraldine-high-school', 'Geraldine High School', '2026-08-17T00:00:00+00:00'),
      ('glencoe-high-school', 'Glencoe High School', '2026-08-17T00:00:00+00:00'),
      ('good-hope-high-school', 'Good Hope High School', '2026-08-17T00:00:00+00:00'),
      ('gordo-high-school', 'Gordo High School', '2026-08-17T00:00:00+00:00'),
      ('greene-county-high-school', 'Greene County High School', '2026-08-17T00:00:00+00:00'),
      ('greensboro-high-school', 'Greensboro High School', '2026-08-17T00:00:00+00:00'),
      ('greenville-high-school', 'Greenville High School', '2026-08-17T00:00:00+00:00'),
      ('grissom-high-school', 'Grissom High School', '2026-08-17T00:00:00+00:00'),
      ('gulf-shores-high-school', 'Gulf Shores High School', '2026-08-17T00:00:00+00:00'),
      ('guntersville-high-school', 'Guntersville High School', '2026-08-17T00:00:00+00:00'),
      ('hackleburg-high-school', 'Hackleburg High School', '2026-08-17T00:00:00+00:00'),
      ('hale-county-high-school', 'Hale County High School', '2026-08-17T00:00:00+00:00'),
      ('haleyville-high-school', 'Haleyville High School', '2026-08-17T00:00:00+00:00'),
      ('hamilton-high-school', 'Hamilton High School', '2026-08-17T00:00:00+00:00'),
      ('hanceville-high-school', 'Hanceville High School', '2026-08-17T00:00:00+00:00'),
      ('hartselle-high-school', 'Hartselle High School', '2026-08-17T00:00:00+00:00'),
      ('hatton-high-school', 'Hatton High School', '2026-08-17T00:00:00+00:00'),
      ('hayden-high-school', 'Hayden High School', '2026-08-17T00:00:00+00:00'),
      ('hazel-green-high-school', 'Hazel Green High School', '2026-08-17T00:00:00+00:00'),
      ('headland-high-school', 'Headland High School', '2026-08-17T00:00:00+00:00'),
      ('helena-high-school', 'Helena High School', '2026-08-17T00:00:00+00:00'),
      ('hewitt-trussville-high-school', 'Hewitt-Trussville High School', '2026-08-17T00:00:00+00:00'),
      ('highland-home-high-school', 'Highland Home High School', '2026-08-17T00:00:00+00:00'),
      ('hillcrest-high-school', 'Hillcrest High School', '2026-08-17T00:00:00+00:00'),
      ('hokes-bluff-high-school', 'Hokes Bluff High School', '2026-08-17T00:00:00+00:00'),
      ('holly-pond-high-school', 'Holly Pond High School', '2026-08-17T00:00:00+00:00'),
      ('holtville-high-school', 'Holtville High School', '2026-08-17T00:00:00+00:00'),
      ('homewood-high-school', 'Homewood High School', '2026-08-17T00:00:00+00:00'),
      ('hoover-high-school', 'Hoover High School', '2026-08-17T00:00:00+00:00'),
      ('horseshoe-bend-high-school', 'Horseshoe Bend High School', '2026-08-17T00:00:00+00:00'),
      ('houston-county-high-school', 'Houston County High School', '2026-08-17T00:00:00+00:00'),
      ('hubbertville-school', 'Hubbertville School', '2026-08-17T00:00:00+00:00'),
      ('hueytown-high-school', 'Hueytown High School', '2026-08-17T00:00:00+00:00'),
      ('huffman-high-school', 'Huffman High School', '2026-08-17T00:00:00+00:00'),
      ('huntsville-high-school', 'Huntsville High School', '2026-08-17T00:00:00+00:00'),
      ('ider-high-school', 'Ider High School', '2026-08-17T00:00:00+00:00'),
      ('isabella-high-school', 'Isabella High School', '2026-08-17T00:00:00+00:00'),
      ('j-b-pennington-high-school', 'J.B. Pennington High School', '2026-08-17T00:00:00+00:00'),
      ('jackson-high-school', 'Jackson High School', '2026-08-17T00:00:00+00:00'),
      ('jackson-olin-high-school', 'Jackson-Olin High School', '2026-08-17T00:00:00+00:00'),
      ('jacksonville-high-school', 'Jacksonville High School', '2026-08-17T00:00:00+00:00'),
      ('james-clemens-high-school', 'James Clemens High School', '2026-08-17T00:00:00+00:00'),
      ('jefferson-county-international-baccalaureate-school', 'Jefferson County International Baccalaureate School', '2026-08-17T00:00:00+00:00'),
      ('jemison-high-school-huntsville', 'Jemison High School (Huntsville)', '2026-08-17T00:00:00+00:00'),
      ('jemison-high-school-jemison', 'Jemison High School (Jemison)', '2026-08-17T00:00:00+00:00'),
      ('kate-duncan-smith-dar-school', 'Kate Duncan Smith DAR School', '2026-08-17T00:00:00+00:00'),
      ('keith-middle-high-school', 'Keith Middle-High School', '2026-08-17T00:00:00+00:00'),
      ('kinston-high-school', 'Kinston High School', '2026-08-17T00:00:00+00:00'),
      ('lafayette-high-school', 'Lafayette High School', '2026-08-17T00:00:00+00:00'),
      ('lamar-county-high-school', 'Lamar County High School', '2026-08-17T00:00:00+00:00'),
      ('lanett-high-school', 'Lanett High School', '2026-08-17T00:00:00+00:00'),
      ('lauderdale-county-high-school', 'Lauderdale County High School', '2026-08-17T00:00:00+00:00'),
      ('lawrence-county-high-school', 'Lawrence County High School', '2026-08-17T00:00:00+00:00'),
      ('leflore-high-school', 'LeFlore High School', '2026-08-17T00:00:00+00:00'),
      ('lee-high-school', 'Lee High School', '2026-08-17T00:00:00+00:00'),
      ('leeds-high-school', 'Leeds High School', '2026-08-17T00:00:00+00:00'),
      ('lexington-high-school', 'Lexington High School', '2026-08-17T00:00:00+00:00'),
      ('linden-high-school', 'Linden High School', '2026-08-17T00:00:00+00:00'),
      ('loachapoka-high-school', 'Loachapoka High School', '2026-08-17T00:00:00+00:00'),
      ('locust-fork-high-school', 'Locust Fork High School', '2026-08-17T00:00:00+00:00'),
      ('luverne-high-school', 'Luverne High School', '2026-08-17T00:00:00+00:00'),
      ('madison-county-high-school', 'Madison County High School', '2026-08-17T00:00:00+00:00'),
      ('maplesville-high-school', 'Maplesville High School', '2026-08-17T00:00:00+00:00'),
      ('marbury-high-school', 'Marbury High School', '2026-08-17T00:00:00+00:00'),
      ('marengo-high-school', 'Marengo High School', '2026-08-17T00:00:00+00:00'),
      ('marion-county-high-school', 'Marion County High School', '2026-08-17T00:00:00+00:00'),
      ('marion-high-school', 'Marion High School', '2026-08-17T00:00:00+00:00'),
      ('mary-g-montgomery-high-school', 'Mary G. Montgomery High School', '2026-08-17T00:00:00+00:00'),
      ('mattie-t-blount-high-school', 'Mattie T. Blount High School', '2026-08-17T00:00:00+00:00'),
      ('mcadory-high-school', 'McAdory High School', '2026-08-17T00:00:00+00:00'),
      ('mckenzie-school', 'McKenzie School', '2026-08-17T00:00:00+00:00'),
      ('midfield-high-school', 'Midfield High School', '2026-08-17T00:00:00+00:00'),
      ('minor-high-school', 'Minor High School', '2026-08-17T00:00:00+00:00'),
      ('monroe-county-high-school', 'Monroe County High School', '2026-08-17T00:00:00+00:00'),
      ('moody-high-school', 'Moody High School', '2026-08-17T00:00:00+00:00'),
      ('mortimer-jordan-high-school', 'Mortimer Jordan High School', '2026-08-17T00:00:00+00:00'),
      ('mountain-brook-high-school', 'Mountain Brook High School', '2026-08-17T00:00:00+00:00'),
      ('munford-high-school', 'Munford High School', '2026-08-17T00:00:00+00:00'),
      ('murphy-high-school', 'Murphy High School', '2026-08-17T00:00:00+00:00'),
      ('muscle-shoals-high-school', 'Muscle Shoals High School', '2026-08-17T00:00:00+00:00'),
      ('new-brockton-high-school', 'New Brockton High School', '2026-08-17T00:00:00+00:00'),
      ('new-century-technology-high-school', 'New Century Technology High School', '2026-08-17T00:00:00+00:00'),
      ('new-hope-high-school', 'New Hope High School', '2026-08-17T00:00:00+00:00'),
      ('north-jackson-high-school', 'North Jackson High School', '2026-08-17T00:00:00+00:00'),
      ('north-sand-mountain-school', 'North Sand Mountain School', '2026-08-17T00:00:00+00:00'),
      ('northport-high-school', 'Northport High School', '2026-08-17T00:00:00+00:00'),
      ('northridge-high-school', 'Northridge High School', '2026-08-17T00:00:00+00:00'),
      ('notasulga-high-school', 'Notasulga High School', '2026-08-17T00:00:00+00:00'),
      ('oak-grove-high-school', 'Oak Grove High School', '2026-08-17T00:00:00+00:00'),
      ('oakman-high-school', 'Oakman High School', '2026-08-17T00:00:00+00:00'),
      ('ohatchee-high-school', 'Ohatchee High School', '2026-08-17T00:00:00+00:00'),
      ('oneonta-high-school', 'Oneonta High School', '2026-08-17T00:00:00+00:00'),
      ('opelika-high-school', 'Opelika High School', '2026-08-17T00:00:00+00:00'),
      ('opp-high-school', 'Opp High School', '2026-08-17T00:00:00+00:00'),
      ('orange-beach-high-school', 'Orange Beach High School', '2026-08-17T00:00:00+00:00'),
      ('oxford-high-school', 'Oxford High School', '2026-08-17T00:00:00+00:00'),
      ('paul-w-bryant-high-school', 'Paul W. Bryant High School', '2026-08-17T00:00:00+00:00'),
      ('pell-city-high-school', 'Pell City High School', '2026-08-17T00:00:00+00:00'),
      ('phenix-city-high-school', 'Phenix City High School', '2026-08-17T00:00:00+00:00'),
      ('phil-campbell-high-school', 'Phil Campbell High School', '2026-08-17T00:00:00+00:00'),
      ('phillips-high-school', 'Phillips High School', '2026-08-17T00:00:00+00:00'),
      ('pickens-county-high-school', 'Pickens County High School', '2026-08-17T00:00:00+00:00'),
      ('piedmont-high-school', 'Piedmont High School', '2026-08-17T00:00:00+00:00'),
      ('pinson-valley-high-school', 'Pinson Valley High School', '2026-08-17T00:00:00+00:00'),
      ('pisgah-high-school', 'Pisgah High School', '2026-08-17T00:00:00+00:00'),
      ('plainview-high-school', 'Plainview High School', '2026-08-17T00:00:00+00:00'),
      ('pleasant-grove-high-school', 'Pleasant Grove High School', '2026-08-17T00:00:00+00:00'),
      ('pleasant-home-school', 'Pleasant Home School', '2026-08-17T00:00:00+00:00'),
      ('pleasant-valley-high-school', 'Pleasant Valley High School', '2026-08-17T00:00:00+00:00'),
      ('prattville-high-school', 'Prattville High School', '2026-08-17T00:00:00+00:00'),
      ('prichard-high-school', 'Prichard High School', '2026-08-17T00:00:00+00:00'),
      ('ramsay-high-school', 'Ramsay High School', '2026-08-17T00:00:00+00:00'),
      ('ranburne-high-school', 'Ranburne High School', '2026-08-17T00:00:00+00:00'),
      ('red-bay-high-school', 'Red Bay High School', '2026-08-17T00:00:00+00:00'),
      ('red-level-high-school', 'Red Level High School', '2026-08-17T00:00:00+00:00'),
      ('rehobeth-high-school', 'Rehobeth High School', '2026-08-17T00:00:00+00:00'),
      ('roanoke-high-school', 'Roanoke High School', '2026-08-17T00:00:00+00:00'),
      ('robert-e-lee-high-school', 'Robert E. Lee High School', '2026-08-17T00:00:00+00:00'),
      ('robertsdale-high-school', 'Robertsdale High School', '2026-08-17T00:00:00+00:00'),
      ('rogers-high-school', 'Rogers High School', '2026-08-17T00:00:00+00:00'),
      ('russellville-high-school', 'Russellville High School', '2026-08-17T00:00:00+00:00'),
      ('saks-high-school', 'Saks High School', '2026-08-17T00:00:00+00:00'),
      ('samson-high-school', 'Samson High School', '2026-08-17T00:00:00+00:00'),
      ('sand-rock-school', 'Sand Rock School', '2026-08-17T00:00:00+00:00'),
      ('saraland-high-school', 'Saraland High School', '2026-08-17T00:00:00+00:00'),
      ('sardis-high-school', 'Sardis High School', '2026-08-17T00:00:00+00:00'),
      ('satsuma-high-school', 'Satsuma High School', '2026-08-17T00:00:00+00:00'),
      ('scottsboro-high-school', 'Scottsboro High School', '2026-08-17T00:00:00+00:00'),
      ('section-high-school', 'Section High School', '2026-08-17T00:00:00+00:00'),
      ('selma-high-school', 'Selma High School', '2026-08-17T00:00:00+00:00'),
      ('shades-valley-high-school', 'Shades Valley High School', '2026-08-17T00:00:00+00:00'),
      ('sheffield-high-school', 'Sheffield High School', '2026-08-17T00:00:00+00:00'),
      ('shelby-county-high-school', 'Shelby County High School', '2026-08-17T00:00:00+00:00'),
      ('sidney-lanier-high-school', 'Sidney Lanier High School', '2026-08-17T00:00:00+00:00'),
      ('skyline-high-school', 'Skyline High School', '2026-08-17T00:00:00+00:00'),
      ('slocomb-high-school', 'Slocomb High School', '2026-08-17T00:00:00+00:00'),
      ('smiths-station-high-school', 'Smiths Station High School', '2026-08-17T00:00:00+00:00'),
      ('somerville-high-school', 'Somerville High School', '2026-08-17T00:00:00+00:00'),
      ('south-lamar-school', 'South Lamar School', '2026-08-17T00:00:00+00:00'),
      ('southern-choctaw-high-school', 'Southern Choctaw High School', '2026-08-17T00:00:00+00:00'),
      ('southside-high-school-gadsden', 'Southside High School (Gadsden)', '2026-08-17T00:00:00+00:00'),
      ('southside-high-school-selma', 'Southside High School (Selma)', '2026-08-17T00:00:00+00:00'),
      ('spanish-fort-high-school', 'Spanish Fort High School', '2026-08-17T00:00:00+00:00'),
      ('sparkman-high-school', 'Sparkman High School', '2026-08-17T00:00:00+00:00'),
      ('spring-garden-school', 'Spring Garden School', '2026-08-17T00:00:00+00:00'),
      ('st-clair-county-high-school', 'St. Clair County High School', '2026-08-17T00:00:00+00:00'),
      ('stanhope-elmore-high-school', 'Stanhope Elmore High School', '2026-08-17T00:00:00+00:00'),
      ('straughn-high-school', 'Straughn High School', '2026-08-17T00:00:00+00:00'),
      ('sulligent-high-school', 'Sulligent High School', '2026-08-17T00:00:00+00:00'),
      ('sumterville-high-school', 'Sumterville High School', '2026-08-17T00:00:00+00:00'),
      ('susan-moore-high-school', 'Susan Moore High School', '2026-08-17T00:00:00+00:00'),
      ('sweet-water-high-school', 'Sweet Water High School', '2026-08-17T00:00:00+00:00'),
      ('sylacauga-high-school', 'Sylacauga High School', '2026-08-17T00:00:00+00:00'),
      ('sylvania-high-school', 'Sylvania High School', '2026-08-17T00:00:00+00:00'),
      ('t-r-miller-high-school', 'T. R. Miller High School', '2026-08-17T00:00:00+00:00'),
      ('talladega-high-school', 'Talladega High School', '2026-08-17T00:00:00+00:00'),
      ('tallassee-high-school', 'Tallassee High School', '2026-08-17T00:00:00+00:00'),
      ('tanner-high-school', 'Tanner High School', '2026-08-17T00:00:00+00:00'),
      ('tarrant-high-school', 'Tarrant High School', '2026-08-17T00:00:00+00:00'),
      ('tharptown-high-school', 'Tharptown High School', '2026-08-17T00:00:00+00:00'),
      ('theodore-high-school', 'Theodore High School', '2026-08-17T00:00:00+00:00'),
      ('thomasville-high-school', 'Thomasville High School', '2026-08-17T00:00:00+00:00'),
      ('thompson-high-school', 'Thompson High School', '2026-08-17T00:00:00+00:00'),
      ('thorsby-high-school', 'Thorsby High School', '2026-08-17T00:00:00+00:00'),
      ('toulminville-high-school', 'Toulminville High School', '2026-08-17T00:00:00+00:00'),
      ('tuscaloosa-high-school', 'Tuscaloosa High School', '2026-08-17T00:00:00+00:00'),
      ('valley-head-high-school', 'Valley Head High School', '2026-08-17T00:00:00+00:00'),
      ('valley-high-school', 'Valley High School', '2026-08-17T00:00:00+00:00'),
      ('verbena-high-school', 'Verbena High School', '2026-08-17T00:00:00+00:00'),
      ('vestavia-hills-high-school', 'Vestavia Hills High School', '2026-08-17T00:00:00+00:00'),
      ('vigor-high-school', 'Vigor High School', '2026-08-17T00:00:00+00:00'),
      ('vina-high-school', 'Vina High School', '2026-08-17T00:00:00+00:00'),
      ('vinemont-high-school', 'Vinemont High School', '2026-08-17T00:00:00+00:00'),
      ('w-s-neal-high-school', 'W. S. Neal High School', '2026-08-17T00:00:00+00:00'),
      ('walker-high-school', 'Walker High School', '2026-08-17T00:00:00+00:00'),
      ('walter-wellborn-high-school', 'Walter Wellborn High School', '2026-08-17T00:00:00+00:00'),
      ('washington-county-high-school', 'Washington County High School', '2026-08-17T00:00:00+00:00'),
      ('waterloo-high-school', 'Waterloo High School', '2026-08-17T00:00:00+00:00'),
      ('weaver-high-school', 'Weaver High School', '2026-08-17T00:00:00+00:00'),
      ('wedowee-high-school', 'Wedowee High School', '2026-08-17T00:00:00+00:00'),
      ('wenonah-high-school', 'Wenonah High School', '2026-08-17T00:00:00+00:00'),
      ('west-blocton-high-school', 'West Blocton High School', '2026-08-17T00:00:00+00:00'),
      ('west-end-high-school', 'West End High School', '2026-08-17T00:00:00+00:00'),
      ('west-limestone-high-school', 'West Limestone High School', '2026-08-17T00:00:00+00:00'),
      ('west-point-high-school', 'West Point High School', '2026-08-17T00:00:00+00:00'),
      ('wetumpka-high-school', 'Wetumpka High School', '2026-08-17T00:00:00+00:00'),
      ('white-plains-high-school', 'White Plains High School', '2026-08-17T00:00:00+00:00'),
      ('wicksburg-high-school', 'Wicksburg High School', '2026-08-17T00:00:00+00:00'),
      ('wilcox-county-high-school', 'Wilcox County High School', '2026-08-17T00:00:00+00:00'),
      ('williamson-high-school', 'Williamson High School', '2026-08-17T00:00:00+00:00'),
      ('winfield-high-school', 'Winfield High School', '2026-08-17T00:00:00+00:00'),
      ('winston-county-high-school', 'Winston County High School', '2026-08-17T00:00:00+00:00'),
      ('woodlawn-high-school', 'Woodlawn High School', '2026-08-17T00:00:00+00:00'),
      ('woodville-high-school', 'Woodville High School', '2026-08-17T00:00:00+00:00'),
      ('york-high-school', 'York High School', '2026-08-17T00:00:00+00:00'),
      ('zion-chapel-high-school', 'Zion Chapel High School', '2026-08-17T00:00:00+00:00')
    ON CONFLICT (id) DO NOTHING;
    """,

    # ── 33: automated structural analysis of uploaded lesson-plan templates ──
    #
    # A school_templates row used to mean "a file is sitting on disk, waiting
    # for an admin to eyeball it and hand-write a builder script." These
    # columns let an automated pipeline (template_intake.py) record what it
    # found before a human ever opens the file: analysis_status tracks where
    # a given upload is in that pipeline (independent of schools.template_status,
    # which is the human's final "yes, use this" switch); structure_json is the
    # deterministic, format-specific extraction (headings, tables, fonts —
    # never the LLM's word); analysis_summary is the LLM's structured read of
    # that extraction; analysis_error holds the message when either stage
    # raised, so a failed analysis is visible instead of just... missing.
    #
    # school_template_findings is the per-check ledger — one row per quality
    # check the pipeline ran, pass or fail, rather than collapsing everything
    # into one status flag. An admin reviewing a template can see exactly
    # which checks passed, which merely warned, and which failed outright,
    # instead of trusting a single boolean that something somewhere was wrong.
    """
    ALTER TABLE school_templates ADD COLUMN IF NOT EXISTS analysis_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE school_templates ADD COLUMN IF NOT EXISTS structure_json TEXT;
    ALTER TABLE school_templates ADD COLUMN IF NOT EXISTS analysis_summary TEXT;
    ALTER TABLE school_templates ADD COLUMN IF NOT EXISTS analysis_error TEXT;
    ALTER TABLE school_templates ADD COLUMN IF NOT EXISTS analyzed_at TEXT;

    CREATE TABLE IF NOT EXISTS school_template_findings (
        id          TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES school_templates(id) ON DELETE CASCADE,
        stage       TEXT NOT NULL,
        check_name  TEXT NOT NULL,
        severity    TEXT NOT NULL,
        message     TEXT NOT NULL,
        created_at  TEXT NOT NULL
    );
    ALTER TABLE school_template_findings ENABLE ROW LEVEL SECURITY;
    CREATE INDEX IF NOT EXISTS idx_school_template_findings_template
        ON school_template_findings(template_id);
    """,

    # ── 34: template auto-activation audit trail ─────────────────────────────
    #
    # template_intake.py can now flip a school straight to 'active' itself,
    # with no admin ever clicking "Mark Active" — see
    # template_intake._maybe_auto_activate's own comment for the (deliberately
    # strict) bar it has to clear. This column is the only record that
    # happened: an auto-activated school no longer appears in the pending
    # queue (list_pending_school_templates filters on template_status), so
    # without it there would be no way to tell "a human reviewed this" from
    # "nobody ever has."
    """
    ALTER TABLE school_templates ADD COLUMN IF NOT EXISTS auto_activated BOOLEAN NOT NULL DEFAULT false;
    """,

    # ── 35: stop defaulting brand-new signups to Florence High School ────────
    #
    # Migration 22's DEFAULT 'florence-high-school' made sense when Florence
    # was the only school in the app; it stopped making sense the moment other
    # real schools existed (migration 23) and every signup — regardless of
    # which school the teacher actually works at — silently started out
    # assigned to Florence's real calendar and template, invisible in the UI
    # (WelcomePage's picker starts blank) until onboarding overwrote it. A
    # teacher who abandoned onboarding partway, or whose account got used
    # before finishing it, was quietly impersonating a real school that
    # wasn't theirs. 'generic' (schoolcal.NO_CALENDAR_SCHOOL_ID) is the
    # correct neutral default: dateless "Week N" planning with no calendar
    # attached, exactly what a not-yet-onboarded account should be.
    #
    # Existing rows are untouched — this only changes what a FUTURE insert
    # gets when it omits `school` (db.create_user does exactly that).
    """
    ALTER TABLE users ALTER COLUMN school SET DEFAULT 'generic';
    """,

    # ── 36: the post-login onboarding wizard ──────────────────────────────────
    #
    # NULL means "never seen it" — the only state that matters for gating
    # whether AppShell mounts the wizard. There's no separate "dismissed"
    # vs "completed" distinction: skipping every step and finishing every
    # step both mean the same thing here, "don't show this again
    # automatically" — SettingsPage's "Take the tour again" link is the
    # deliberate re-entry point for anyone who wants it back.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_seen_at TEXT;
    """,

    # ── 37: sub plans ─────────────────────────────────────────────────────────
    """
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS mode TEXT;
    """,

    # ── 38: grades stored as LABELS, not values ───────────────────────────────
    #
    # WelcomePage used to POST the grade's label ("11th") where every reader
    # expects its value ("11") — its own comment documents the visible half of
    # that bug ("AP Language & Composition · NaNth", from _auto_name's int()).
    # The frontend was fixed; the rows it had already written were not, and
    # nothing heals them on read, so two of five live classes still hold a
    # label today.
    #
    # The invisible half is the dangerous one. service._resolve_subject_grade
    # does int(grade_str) inside a try and falls back to 11 — so a class stored
    # as "12th" doesn't error, it silently retrieves GRADE 11 standards and
    # cites them with real-looking codes. That is exactly the failure
    # retrieval.py's own comment calls out: "each grade re-uses standard
    # numbers 1-30, so grade must always be part of the filter" — a wrong-grade
    # answer looks right and is wrong, which is the one thing this product
    # exists to prevent.
    #
    # The visible half: '11th' matches no <option value>, so every grade <select>
    # in the app (the onboarding wizard, ClassPage's edit panel) silently fell
    # back to displaying its FIRST option — showing an AP English 11 class as
    # Kindergarten.
    #
    # Ordinal suffix only. Anything else a grade column might hold ('K', '',
    # NULL, a number already) is left exactly as it is: this migration's job is
    # to undo one known bad write, not to guess at values it didn't create.
    """
    UPDATE classes
       SET grade = regexp_replace(grade, '^\\s*(\\d{1,2})\\s*(st|nd|rd|th)\\s*$', '\\1')
     WHERE grade ~ '^\\s*\\d{1,2}\\s*(st|nd|rd|th)\\s*$';
    UPDATE settings
       SET grade = regexp_replace(grade, '^\\s*(\\d{1,2})\\s*(st|nd|rd|th)\\s*$', '\\1')
     WHERE grade ~ '^\\s*\\d{1,2}\\s*(st|nd|rd|th)\\s*$';
    """,

    # ── 39: sharing a plan has to be a decision ───────────────────────────────
    #
    # GET /api/plans/public/{plan_id} takes no auth and called
    # db.get_public_plan, which was "SELECT * FROM plans WHERE id = ?" — no
    # owner check and no notion of a plan having been shared. Verified against
    # the live database with no cookie at all: HTTP 200 and 4KB of a real
    # teacher's plan that had never been shared with anyone. POST
    # /{plan_id}/fork resolved the same way, so any signed-in account could
    # also COPY any plan it knew the id of.
    #
    # Row-level security does not save this. The policies exist and
    # `plans` has relrowsecurity = true, but relforcerowsecurity = false and
    # the app connects as `postgres`, which owns the table — and RLS is
    # bypassed for a table's owner. Measured, not assumed. So the
    # `WHERE user_id = ?` predicates in this module are the ONLY tenancy
    # boundary this app actually has, which is exactly why an endpoint that
    # forgot one mattered so much.
    #
    # The fix keeps the capability-URL shape the feature was built around
    # (/shared/{plan_id}, which several buttons already copy to the clipboard)
    # and adds the one thing it was missing: the teacher has to opt in, and can
    # change their mind. Default FALSE, so every plan that exists today stops
    # being readable the moment this runs.
    """
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS shared_at TEXT;
    """,

    # ── 40: which accounts are Google accounts ────────────────────────────────
    #
    # An email address was the only thing tying a Google sign-in to a row in
    # `users`, and password_hash IS NULL was the only marker that a row had no
    # local password. signup() read that second fact as "an unclaimed
    # placeholder seat, free to take" — which every Google account in the
    # product matched. Verified live before the fix: POST /api/auth/signup with
    # a Google account's email returned 200 and a valid session for its owner.
    #
    # Google's `sub` is the stable, immutable identifier for the account (email
    # is mutable and reassignable), so it is what google_login matches on now.
    # Nullable and backfilled on next sign-in rather than migrated: nothing can
    # derive a sub for an existing row, and google_login falls back to the email
    # lookup so no one is locked out while the column fills in.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub) WHERE google_sub IS NOT NULL;
    """,

    # ── 41: time-boxed beta accounts ──────────────────────────────────────────
    #
    # For handing the app to a few outside teachers for a fixed trial window —
    # created from the admin panel (POST /api/admin/beta-accounts), not a
    # bespoke row Josh writes by hand. NULL means "not a beta account, or no
    # expiry" so every normal signup is completely unaffected; deps._verify_current
    # is where a past expiry actually ends the session (see its own comment).
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_expires_at TEXT;
    """,

    # ── 42: add state column to classes ───────────────────────────────────────
    # The `state` column was added to the `classes` table creation block in an
    # earlier migration, but if that migration was already applied, the column
    # never gets added to existing deployments. This explicit migration ensures
    # it exists everywhere so `db.create_class` can safely insert into it.
    """
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS state TEXT;
    """,

    # ── 43: idempotent client identifiers for message persistence ────────────
    # A browser retry must not create a second transcript message.  The
    # partial unique index keeps old/imported messages valid while making a
    # client-generated id safe to reuse across retries.
    """
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
      ON messages (chat_id, client_id) WHERE client_id IS NOT NULL;
    """,
    # ── 44: per-class custom instructions ─────────────────────────────────────
    #
    # Migration 19's global custom_instructions lives on `users` — one set of
    # style/format preferences for every class a teacher teaches. This is the
    # per-class layer on top of it: a class column, additive rather than a
    # replacement, so a teacher's account-wide preferences don't have to be
    # copy-pasted into every class just to add one class-specific note.
    #
    # Spliced into prompts.py's blocks AFTER the global custom-instructions
    # block, same non-negotiable-override relationship to grounding_constraints()
    # that migration 19's comment already explains.
    """
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS custom_instructions TEXT;
    """,
    # ── 45: RLS on llm_cache ─────────────────────────────────────────────────
    #
    # Migration 21 created this table without the ENABLE ROW LEVEL SECURITY
    # line every other table-creating migration carries (see 17's usage_events),
    # so it was the one table in `public` left open to PostgREST and the anon
    # key. Supabase's advisor flagged it as the only remaining ERROR.
    #
    # No policies, for the reason spelled out in migration 12: the app connects
    # as `postgres` (BYPASSRLS) and nothing else has any business in here.
    """
    ALTER TABLE llm_cache ENABLE ROW LEVEL SECURITY;
    """,
    # ── 46: admin settings + audit log ───────────────────────────────────────
    #
    # app_settings is a singleton row (id BOOLEAN PRIMARY KEY DEFAULT true,
    # CHECK (id)), the same shape migration 1's `settings` table used for its
    # own single-teacher config — there is exactly one value of each cap, ever,
    # so a real table with a WHERE clause would be answering a question
    # ("which row?") that doesn't exist. Seeded from config.py's own defaults
    # so a fresh deploy's admin Settings tab shows the same numbers
    # entitlement.py already enforced before this table existed. Distinct from
    # migration 28's per-account custom_weekly_token_cap: that's one
    # account's override, this is the tier-wide default everyone else falls
    # back to.
    #
    # admin_audit_log exists because the two admin actions that predate it —
    # granting/revoking comped access, adding/removing a school — had no
    # record of who did it or when, only current state. actor_id has no FK:
    # an admin account can be deleted later and the log should still read who
    # did it, not silently lose the row.
    f"""
    CREATE TABLE IF NOT EXISTS app_settings (
      id                           BOOLEAN PRIMARY KEY DEFAULT true,
      free_weekly_token_cap        INTEGER NOT NULL,
      subscriber_weekly_token_cap  INTEGER NOT NULL,
      updated_at                   TEXT NOT NULL,
      updated_by                   TEXT,
      CHECK (id)
    );
    ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

    INSERT INTO app_settings (id, free_weekly_token_cap, subscriber_weekly_token_cap, updated_at)
    VALUES (true, {settings.free_weekly_token_cap}, {settings.subscriber_weekly_token_cap}, '2026-08-15T00:00:00+00:00')
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id         SERIAL PRIMARY KEY,
      actor_id   TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON admin_audit_log(created_at DESC);
    ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
    """,
    # ── 47: FERPA-style audit log ─────────────────────────────────────────────
    #
    # A broader access/action trail than migration 46's admin_audit_log: this
    # one also covers actions a TEACHER takes on their own account (export,
    # delete), not just admin actions on someone else's. Distinct from
    # usage_events (that's token spend) and from backend_audit.log (that's the
    # server's own request log, rotated and local, not a queryable record).
    #
    # actor_user_id is nullable rather than a hard FK: the actor is gone by
    # the time a delete_account row is written (the account it deleted was
    # its own), so a FK ON DELETE CASCADE would erase the very record of the
    # deletion. target_user_id is the account acted upon, when different from
    # the actor (e.g. an admin comping someone else's account).
    """
    CREATE TABLE IF NOT EXISTS audit_log (
        id             TEXT PRIMARY KEY,
        created_at     TEXT NOT NULL,
        actor_user_id  TEXT,
        action         TEXT NOT NULL,
        target_user_id TEXT,
        detail         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_user_id);
    """,
# ── 49: All Alabama public schools (Elementary, Middle, etc) ───────────────
    """
    INSERT INTO schools (id, name, created_at) VALUES
      ('albertville-middle-school', 'Albertville Middle School', '2026-08-25T00:00:00+00:00'),
      ('albertville-high-school', 'Albertville High School', '2026-08-25T00:00:00+00:00'),
      ('albertville-intermediate-school', 'Albertville Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('albertville-elementary-school', 'Albertville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('albertville-kindergarten-and-prek', 'Albertville Kindergarten And Prek', '2026-08-25T00:00:00+00:00'),
      ('albertville-primary-school', 'Albertville Primary School', '2026-08-25T00:00:00+00:00'),
      ('kate-duncan-smith-dar-middle', 'Kate Duncan Smith Dar Middle', '2026-08-25T00:00:00+00:00'),
      ('asbury-high-school', 'Asbury High School', '2026-08-25T00:00:00+00:00'),
      ('claysville-school', 'Claysville School', '2026-08-25T00:00:00+00:00'),
      ('douglas-elementary-school', 'Douglas Elementary School', '2026-08-25T00:00:00+00:00'),
      ('douglas-high-school', 'Douglas High School', '2026-08-25T00:00:00+00:00'),
      ('brindlee-mountain-elementary-school', 'Brindlee Mountain Elementary School', '2026-08-25T00:00:00+00:00'),
      ('kate-d-smith-dar-high-school', 'Kate D Smith Dar High School', '2026-08-25T00:00:00+00:00'),
      ('brindlee-mountain-primary-school', 'Brindlee Mountain Primary School', '2026-08-25T00:00:00+00:00'),
      ('marshall-alternative-school', 'Marshall Alternative School', '2026-08-25T00:00:00+00:00'),
      ('marshall-technical-school', 'Marshall Technical School', '2026-08-25T00:00:00+00:00'),
      ('robert-d-sloman-primary', 'Robert D Sloman Primary', '2026-08-25T00:00:00+00:00'),
      ('brindlee-mountain-high-school', 'Brindlee Mountain High School', '2026-08-25T00:00:00+00:00'),
      ('kate-d-smith-dar-elementary-school', 'Kate D Smith Dar Elementary School', '2026-08-25T00:00:00+00:00'),
      ('douglas-middle-school', 'Douglas Middle School', '2026-08-25T00:00:00+00:00'),
      ('asbury-elementary-school', 'Asbury Elementary School', '2026-08-25T00:00:00+00:00'),
      ('trace-crossings-elementary-school', 'Trace Crossings Elementary School', '2026-08-25T00:00:00+00:00'),
      ('greystone-elementary-school', 'Greystone Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hoover-high-school', 'Hoover High School', '2026-08-25T00:00:00+00:00'),
      ('berry-middle-school', 'Berry Middle School', '2026-08-25T00:00:00+00:00'),
      ('south-shades-crest-elementary-school', 'South Shades Crest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('robert-f-bumpus-middle-school', 'Robert F Bumpus Middle School', '2026-08-25T00:00:00+00:00'),
      ('spain-park-high-school', 'Spain Park High School', '2026-08-25T00:00:00+00:00'),
      ('deer-valley-elementary-school', 'Deer Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bluff-park-elementary-school', 'Bluff Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('green-valley-elementary-school', 'Green Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('gwin-elementary-school', 'Gwin Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ira-f-simmons-middle-school', 'Ira F Simmons Middle School', '2026-08-25T00:00:00+00:00'),
      ('rocky-ridge-elementary-school', 'Rocky Ridge Elementary School', '2026-08-25T00:00:00+00:00'),
      ('shades-mountain-elementary-school', 'Shades Mountain Elementary School', '2026-08-25T00:00:00+00:00'),
      ('riverchase-elementary-school', 'Riverchase Elementary School', '2026-08-25T00:00:00+00:00'),
      ('brocks-gap-intermediate-school', 'Brocks Gap Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('crossroads-school', 'Crossroads School', '2026-08-25T00:00:00+00:00'),
      ('riverchase-career-connection-center', 'Riverchase Career Connection Center', '2026-08-25T00:00:00+00:00'),
      ('horizon-elementary-school', 'Horizon Elementary School', '2026-08-25T00:00:00+00:00'),
      ('discovery-middle-school', 'Discovery Middle School', '2026-08-25T00:00:00+00:00'),
      ('bob-jones-high-school', 'Bob Jones High School', '2026-08-25T00:00:00+00:00'),
      ('madison-elementary-school', 'Madison Elementary School', '2026-08-25T00:00:00+00:00'),
      ('midtown-elementary-school', 'Midtown Elementary School', '2026-08-25T00:00:00+00:00'),
      ('heritage-elementary-school', 'Heritage Elementary School', '2026-08-25T00:00:00+00:00'),
      ('rainbow-elementary-school', 'Rainbow Elementary School', '2026-08-25T00:00:00+00:00'),
      ('liberty-middle-school', 'Liberty Middle School', '2026-08-25T00:00:00+00:00'),
      ('columbia-elementary-school', 'Columbia Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mill-creek-elementary-school', 'Mill Creek Elementary School', '2026-08-25T00:00:00+00:00'),
      ('james-clemens-high-school', 'James Clemens High School', '2026-08-25T00:00:00+00:00'),
      ('journey-middle-school', 'Journey Middle School', '2026-08-25T00:00:00+00:00'),
      ('alabama-school-for-deaf', 'Alabama School For Deaf', '2026-08-25T00:00:00+00:00'),
      ('alabama-school-for-blind', 'Alabama School For Blind', '2026-08-25T00:00:00+00:00'),
      ('helen-keller-school', 'Helen Keller School', '2026-08-25T00:00:00+00:00'),
      ('e-h-gentry-technical-facility', 'E H Gentry Technical Facility', '2026-08-25T00:00:00+00:00'),
      ('child-count-only', 'Child Count Only', '2026-08-25T00:00:00+00:00'),
      ('leeds-elementary-school', 'Leeds Elementary School', '2026-08-25T00:00:00+00:00'),
      ('leeds-middle-school', 'Leeds Middle School', '2026-08-25T00:00:00+00:00'),
      ('leeds-high-school', 'Leeds High School', '2026-08-25T00:00:00+00:00'),
      ('leeds-primary-school', 'Leeds Primary School', '2026-08-25T00:00:00+00:00'),
      ('boaz-middle-school', 'Boaz Middle School', '2026-08-25T00:00:00+00:00'),
      ('boaz-high-school', 'Boaz High School', '2026-08-25T00:00:00+00:00'),
      ('corley-elementary-school', 'Corley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('boaz-intermediate-school', 'Boaz Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('boaz-elementary-school', 'Boaz Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hewitttrussville-middle-school', 'Hewitttrussville Middle School', '2026-08-25T00:00:00+00:00'),
      ('paine-elementary-school', 'Paine Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hewitttrussville-high-school', 'Hewitttrussville High School', '2026-08-25T00:00:00+00:00'),
      ('magnolia-elementary-school', 'Magnolia Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cahaba-elementary-school', 'Cahaba Elementary School', '2026-08-25T00:00:00+00:00'),
      ('alexander-city-middle-school', 'Alexander City Middle School', '2026-08-25T00:00:00+00:00'),
      ('benjamin-russell-high-school', 'Benjamin Russell High School', '2026-08-25T00:00:00+00:00'),
      ('jim-pearson-elementary-school', 'Jim Pearson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('nathaniel-h-stephens-elementary-school', 'Nathaniel H Stephens Elementary School', '2026-08-25T00:00:00+00:00'),
      ('william-l-radney-elementary-school', 'William L Radney Elementary School', '2026-08-25T00:00:00+00:00'),
      ('andalusia-high-school', 'Andalusia High School', '2026-08-25T00:00:00+00:00'),
      ('andalusia-junior-high', 'Andalusia Junior High', '2026-08-25T00:00:00+00:00'),
      ('andalusia-elementary-school', 'Andalusia Elementary School', '2026-08-25T00:00:00+00:00'),
      ('anniston-high-school', 'Anniston High School', '2026-08-25T00:00:00+00:00'),
      ('golden-springs-elementary-school', 'Golden Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('randolph-park-elementary-school', 'Randolph Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tenth-street-elementary-school', 'Tenth Street Elementary School', '2026-08-25T00:00:00+00:00'),
      ('anniston-city-boot-camp-school', 'Anniston City Boot Camp School', '2026-08-25T00:00:00+00:00'),
      ('anniston-middle-school', 'Anniston Middle School', '2026-08-25T00:00:00+00:00'),
      ('cobb-preparatory-academy', 'Cobb Preparatory Academy', '2026-08-25T00:00:00+00:00'),
      ('arab-elementary-school', 'Arab Elementary School', '2026-08-25T00:00:00+00:00'),
      ('arab-primary-school', 'Arab Primary School', '2026-08-25T00:00:00+00:00'),
      ('arab-junior-high-school', 'Arab Junior High School', '2026-08-25T00:00:00+00:00'),
      ('arab-high-school', 'Arab High School', '2026-08-25T00:00:00+00:00'),
      ('athens-intermediate-school', 'Athens Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('athens-elementary-school', 'Athens Elementary School', '2026-08-25T00:00:00+00:00'),
      ('athens-high-school', 'Athens High School', '2026-08-25T00:00:00+00:00'),
      ('athens-middle-school', 'Athens Middle School', '2026-08-25T00:00:00+00:00'),
      ('james-l-cowart-elementary-school', 'James L Cowart Elementary School', '2026-08-25T00:00:00+00:00'),
      ('julian-newman-elementary-school', 'Julian Newman Elementary School', '2026-08-25T00:00:00+00:00'),
      ('brookhill-elementary-school', 'Brookhill Elementary School', '2026-08-25T00:00:00+00:00'),
      ('athens-renaissance-school', 'Athens Renaissance School', '2026-08-25T00:00:00+00:00'),
      ('childersburg-boot-camp', 'Childersburg Boot Camp', '2026-08-25T00:00:00+00:00'),
      ('draper-correctional-facility', 'Draper Correctional Facility', '2026-08-25T00:00:00+00:00'),
      ('tutwiler-prison', 'Tutwiler Prison', '2026-08-25T00:00:00+00:00'),
      ('w-e-donaldson', 'W E Donaldson', '2026-08-25T00:00:00+00:00'),
      ('jf-ingram-state-technical-college-special-services', 'Jf Ingram State Technical College Special Services', '2026-08-25T00:00:00+00:00'),
      ('kilby-correctional-facility', 'Kilby Correctional Facility', '2026-08-25T00:00:00+00:00'),
      ('staton-correctional-facility', 'Staton Correctional Facility', '2026-08-25T00:00:00+00:00'),
      ('frank-lee-youth-center', 'Frank Lee Youth Center', '2026-08-25T00:00:00+00:00'),
      ('etowah-high-school', 'Etowah High School', '2026-08-25T00:00:00+00:00'),
      ('etowah-middle-school', 'Etowah Middle School', '2026-08-25T00:00:00+00:00'),
      ('attalla-elementary-school', 'Attalla Elementary School', '2026-08-25T00:00:00+00:00'),
      ('saraland-middle-schooladams-campus', 'Saraland Middle Schooladams Campus', '2026-08-25T00:00:00+00:00'),
      ('saraland-elementary-school', 'Saraland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('saraland-high-school', 'Saraland High School', '2026-08-25T00:00:00+00:00'),
      ('saraland-early-education-center', 'Saraland Early Education Center', '2026-08-25T00:00:00+00:00'),
      ('chickasaw-city-elementary-school', 'Chickasaw City Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chickasaw-city-high-school', 'Chickasaw City High School', '2026-08-25T00:00:00+00:00'),
      ('chickasaw-middle-school', 'Chickasaw Middle School', '2026-08-25T00:00:00+00:00'),
      ('alabama-destinations-career-academy', 'Alabama Destinations Career Academy', '2026-08-25T00:00:00+00:00'),
      ('satsuma-high-school', 'Satsuma High School', '2026-08-25T00:00:00+00:00'),
      ('robert-e-lee-elementary', 'Robert E Lee Elementary', '2026-08-25T00:00:00+00:00'),
      ('thompson-intermediate-school', 'Thompson Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('thompson-high-school', 'Thompson High School', '2026-08-25T00:00:00+00:00'),
      ('thompson-middle-school', 'Thompson Middle School', '2026-08-25T00:00:00+00:00'),
      ('meadow-view-elementary-school', 'Meadow View  Elementary School', '2026-08-25T00:00:00+00:00'),
      ('creek-view-elementary-school', 'Creek View Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pelham-oaks', 'Pelham Oaks', '2026-08-25T00:00:00+00:00'),
      ('pelham-ridge', 'Pelham Ridge', '2026-08-25T00:00:00+00:00'),
      ('pelham-park-middle-school', 'Pelham Park Middle School', '2026-08-25T00:00:00+00:00'),
      ('pelham-high-school', 'Pelham High School', '2026-08-25T00:00:00+00:00'),
      ('pike-road-elementary-school', 'Pike Road Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pike-road-intermediate-school', 'Pike Road Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('pike-road-high-school', 'Pike Road High School', '2026-08-25T00:00:00+00:00'),
      ('pike-road-jr-high-school', 'Pike Road Jr High School', '2026-08-25T00:00:00+00:00'),
      ('acceleration-day-and-evening-academy', 'Acceleration Day And Evening Academy', '2026-08-25T00:00:00+00:00'),
      ('acceleration-preparatory-academy', 'Acceleration Preparatory Academy', '2026-08-25T00:00:00+00:00'),
      ('university-charter-school-elementary', 'University Charter School  Elementary', '2026-08-25T00:00:00+00:00'),
      ('university-charter-school-secondary', 'University Charter School  Secondary', '2026-08-25T00:00:00+00:00'),
      ('legacy-prep', 'Legacy Prep', '2026-08-25T00:00:00+00:00'),
      ('gulf-shores-elementary-school', 'Gulf Shores Elementary School', '2026-08-25T00:00:00+00:00'),
      ('gulf-shores-middle-school', 'Gulf Shores Middle School', '2026-08-25T00:00:00+00:00'),
      ('gulf-shores-high-school', 'Gulf Shores High School', '2026-08-25T00:00:00+00:00'),
      ('lead-academy-building-a', 'Lead Academy Building A', '2026-08-25T00:00:00+00:00'),
      ('lead-academy-building-b', 'Lead Academy Building B', '2026-08-25T00:00:00+00:00'),
      ('i3-academy-phase-1', 'I3 Academy Phase 1', '2026-08-25T00:00:00+00:00'),
      ('i3-academy-phase-2', 'I3 Academy Phase 2', '2026-08-25T00:00:00+00:00'),
      ('life-academy-at-historic-st-jude-educational-institute', 'Life Academy At Historic St Jude Educational Institute', '2026-08-25T00:00:00+00:00'),
      ('breakthrough-charter-school', 'Breakthrough Charter School', '2026-08-25T00:00:00+00:00'),
      ('auburn-high-school', 'Auburn High School', '2026-08-25T00:00:00+00:00'),
      ('auburn-junior-high-school', 'Auburn Junior High School', '2026-08-25T00:00:00+00:00'),
      ('cary-woods-elementary-school', 'Cary Woods Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dean-road-elementary-school', 'Dean Road Elementary School', '2026-08-25T00:00:00+00:00'),
      ('drake-middle-school', 'Drake Middle School', '2026-08-25T00:00:00+00:00'),
      ('wrights-mill-road-elementary-school', 'Wrights Mill Road Elementary School', '2026-08-25T00:00:00+00:00'),
      ('auburn-early-education-center', 'Auburn Early Education Center', '2026-08-25T00:00:00+00:00'),
      ('ogletree-elementary-school', 'Ogletree Elementary School', '2026-08-25T00:00:00+00:00'),
      ('margaret-yarbrough-elementary-school', 'Margaret Yarbrough Elementary School', '2026-08-25T00:00:00+00:00'),
      ('richland-elementary-school', 'Richland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pick-elementary-school', 'Pick Elementary School', '2026-08-25T00:00:00+00:00'),
      ('east-samford-school', 'East Samford School', '2026-08-25T00:00:00+00:00'),
      ('creekside-elementary-school', 'Creekside Elementary School', '2026-08-25T00:00:00+00:00'),
      ('woodland-pines-elementary-school', 'Woodland Pines Elementary School', '2026-08-25T00:00:00+00:00'),
      ('magic-city-acceptance-academy', 'Magic City Acceptance Academy', '2026-08-25T00:00:00+00:00'),
      ('alabama-aerospace-and-aviation-high-school', 'Alabama Aerospace And Aviation High School', '2026-08-25T00:00:00+00:00'),
      ('billingsley-high-school', 'Billingsley High School', '2026-08-25T00:00:00+00:00'),
      ('marbury-high-school', 'Marbury High School', '2026-08-25T00:00:00+00:00'),
      ('prattville-elementary-school', 'Prattville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('prattville-high-school', 'Prattville High School', '2026-08-25T00:00:00+00:00'),
      ('prattville-junior-high-school', 'Prattville Junior High School', '2026-08-25T00:00:00+00:00'),
      ('prattville-intermediate-school', 'Prattville Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('prattville-primary-school', 'Prattville Primary School', '2026-08-25T00:00:00+00:00'),
      ('pine-level-elementary-school', 'Pine Level Elementary School', '2026-08-25T00:00:00+00:00'),
      ('daniel-pratt-elementary-school', 'Daniel Pratt Elementary School', '2026-08-25T00:00:00+00:00'),
      ('autauga-county-alternative-school', 'Autauga County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('autauga-county-technology-center', 'Autauga County Technology Center', '2026-08-25T00:00:00+00:00'),
      ('autaugaville-school', 'Autaugaville School', '2026-08-25T00:00:00+00:00'),
      ('louise-m-smith-development-center', 'Louise M Smith Development Center', '2026-08-25T00:00:00+00:00'),
      ('prattville-kindergarten-school', 'Prattville Kindergarten School', '2026-08-25T00:00:00+00:00'),
      ('marbury-middle-school', 'Marbury Middle School', '2026-08-25T00:00:00+00:00'),
      ('daphne-middle-school', 'Daphne Middle School', '2026-08-25T00:00:00+00:00'),
      ('robertsdale-high-school', 'Robertsdale High School', '2026-08-25T00:00:00+00:00'),
      ('w-j-carroll-intermediate-school', 'W J Carroll Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('elberta-high-school', 'Elberta High School', '2026-08-25T00:00:00+00:00'),
      ('elsanor-school', 'Elsanor School', '2026-08-25T00:00:00+00:00'),
      ('fairhope-middle-school', 'Fairhope Middle School', '2026-08-25T00:00:00+00:00'),
      ('foley-middle-school', 'Foley Middle School', '2026-08-25T00:00:00+00:00'),
      ('perdido-elementary-school', 'Perdido Elementary School', '2026-08-25T00:00:00+00:00'),
      ('rosinton-school', 'Rosinton School', '2026-08-25T00:00:00+00:00'),
      ('silverhill-school', 'Silverhill School', '2026-08-25T00:00:00+00:00'),
      ('spanish-fort-elementary-school', 'Spanish Fort Elementary School', '2026-08-25T00:00:00+00:00'),
      ('stapleton-school', 'Stapleton School', '2026-08-25T00:00:00+00:00'),
      ('summerdale-school', 'Summerdale School', '2026-08-25T00:00:00+00:00'),
      ('swift-elementary-school', 'Swift Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fairhope-high-school', 'Fairhope High School', '2026-08-25T00:00:00+00:00'),
      ('central-baldwin-middle-school', 'Central Baldwin Middle School', '2026-08-25T00:00:00+00:00'),
      ('orange-beach-elementary-school', 'Orange Beach Elementary School', '2026-08-25T00:00:00+00:00'),
      ('rockwell-elementary-school', 'Rockwell Elementary School', '2026-08-25T00:00:00+00:00'),
      ('elberta-elementary-school', 'Elberta Elementary School', '2026-08-25T00:00:00+00:00'),
      ('magnolia-school', 'Magnolia School', '2026-08-25T00:00:00+00:00'),
      ('j-larry-newton-school', 'J Larry Newton School', '2026-08-25T00:00:00+00:00'),
      ('north-baldwin-center-for-technology', 'North Baldwin Center For Technology', '2026-08-25T00:00:00+00:00'),
      ('south-baldwin-center-for-technology', 'South Baldwin Center For Technology', '2026-08-25T00:00:00+00:00'),
      ('bay-minette-elementary-school', 'Bay Minette Elementary School', '2026-08-25T00:00:00+00:00'),
      ('daphne-elementary-school', 'Daphne Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fairhope-east-elementary', 'Fairhope East Elementary', '2026-08-25T00:00:00+00:00'),
      ('fairhope-west-elementary', 'Fairhope West Elementary', '2026-08-25T00:00:00+00:00'),
      ('foley-elementary-school', 'Foley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('florence-b-mathis-elementary', 'Florence B Mathis Elementary', '2026-08-25T00:00:00+00:00'),
      ('loxley-elementary-school', 'Loxley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pine-grove-elementary-school', 'Pine Grove Elementary School', '2026-08-25T00:00:00+00:00'),
      ('robertsdale-elementary-school', 'Robertsdale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('daphne-high-school', 'Daphne High School', '2026-08-25T00:00:00+00:00'),
      ('delta-elementary-school', 'Delta Elementary School', '2026-08-25T00:00:00+00:00'),
      ('foley-high-school', 'Foley High School', '2026-08-25T00:00:00+00:00'),
      ('baldwin-county-high-school', 'Baldwin County High School', '2026-08-25T00:00:00+00:00'),
      ('bay-minette-middle-school', 'Bay Minette Middle School', '2026-08-25T00:00:00+00:00'),
      ('spanish-fort-middle-school', 'Spanish Fort Middle School', '2026-08-25T00:00:00+00:00'),
      ('daphne-east-elementary-school', 'Daphne East Elementary School', '2026-08-25T00:00:00+00:00'),
      ('spanish-fort-high-school', 'Spanish Fort High School', '2026-08-25T00:00:00+00:00'),
      ('cf-taylor-alternative-school', 'Cf Taylor Alternative School', '2026-08-25T00:00:00+00:00'),
      ('baldwin-county-virtual-school', 'Baldwin County Virtual School', '2026-08-25T00:00:00+00:00'),
      ('orange-beach-middlehigh-school', 'Orange Beach Middlehigh School', '2026-08-25T00:00:00+00:00'),
      ('elberta-middle-school', 'Elberta Middle School', '2026-08-25T00:00:00+00:00'),
      ('belforest-elementary-school', 'Belforest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('baldwin-county-elementary-virtual-school', 'Baldwin County Elementary Virtual School', '2026-08-25T00:00:00+00:00'),
      ('stonebridge-elementary', 'Stonebridge Elementary', '2026-08-25T00:00:00+00:00'),
      ('barbour-county-high-school', 'Barbour County High School', '2026-08-25T00:00:00+00:00'),
      ('barbour-county-primary-school', 'Barbour County Primary School', '2026-08-25T00:00:00+00:00'),
      ('barbour-county-intermediate-school', 'Barbour County Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('greenwood-elementary-school', 'Greenwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('charles-f-hard-elementary-school', 'Charles F Hard Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bessemer-city-middle-school', 'Bessemer City Middle School', '2026-08-25T00:00:00+00:00'),
      ('bessemer-city-high-school', 'Bessemer City High School', '2026-08-25T00:00:00+00:00'),
      ('jonesboro-elementary-school', 'Jonesboro Elementary School', '2026-08-25T00:00:00+00:00'),
      ('westhills-elementary-school', 'Westhills Elementary School', '2026-08-25T00:00:00+00:00'),
      ('new-horizon-alternative-school', 'New Horizon Alternative School', '2026-08-25T00:00:00+00:00'),
      ('bessemer-center-for-technology', 'Bessemer Center For Technology', '2026-08-25T00:00:00+00:00'),
      ('abrams-elementary-school', 'Abrams Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bibb-county-high-school', 'Bibb County High School', '2026-08-25T00:00:00+00:00'),
      ('centreville-middle-school', 'Centreville Middle School', '2026-08-25T00:00:00+00:00'),
      ('brent-elementary-school', 'Brent Elementary School', '2026-08-25T00:00:00+00:00'),
      ('randolph-elementary-school', 'Randolph Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-blocton-elementary-school', 'West Blocton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-blocton-high-school', 'West Blocton High School', '2026-08-25T00:00:00+00:00'),
      ('bibb-county-career-academy', 'Bibb County Career Academy', '2026-08-25T00:00:00+00:00'),
      ('west-blocton-middle-school', 'West Blocton Middle School', '2026-08-25T00:00:00+00:00'),
      ('woodstock-elementary-school', 'Woodstock Elementary School', '2026-08-25T00:00:00+00:00'),
      ('engle-day-treatment', 'Engle Day Treatment', '2026-08-25T00:00:00+00:00'),
      ('avondale-elementary-school', 'Avondale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('barrett-elementary-school', 'Barrett Elementary School', '2026-08-25T00:00:00+00:00'),
      ('charles-a-brown-elementary-school', 'Charles A Brown Elementary School', '2026-08-25T00:00:00+00:00'),
      ('central-park-elementary-school', 'Central Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('christian-school', 'Christian School', '2026-08-25T00:00:00+00:00'),
      ('epic-alternative-elementary-school', 'Epic Alternative Elementary School', '2026-08-25T00:00:00+00:00'),
      ('oliver-k5-school', 'Oliver K5 School', '2026-08-25T00:00:00+00:00'),
      ('green-acres-middle-school', 'Green Acres Middle School', '2026-08-25T00:00:00+00:00'),
      ('hemphill-elementary-school', 'Hemphill Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hudson-keight-school', 'Hudson Keight School', '2026-08-25T00:00:00+00:00'),
      ('huffman-middle-school', 'Huffman Middle School', '2026-08-25T00:00:00+00:00'),
      ('huffman-high-schoolmagnet', 'Huffman High Schoolmagnet', '2026-08-25T00:00:00+00:00'),
      ('inglenook-school', 'Inglenook School', '2026-08-25T00:00:00+00:00'),
      ('minor-elementary-school', 'Minor Elementary School', '2026-08-25T00:00:00+00:00'),
      ('norwood-elementary-school', 'Norwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('jacksonolin-high-school', 'Jacksonolin High School', '2026-08-25T00:00:00+00:00'),
      ('parker-high-school', 'Parker High School', '2026-08-25T00:00:00+00:00'),
      ('princeton-school', 'Princeton School', '2026-08-25T00:00:00+00:00'),
      ('we-putnam-middle-schoolmagnet', 'We Putnam Middle Schoolmagnet', '2026-08-25T00:00:00+00:00'),
      ('ramsay-high-school', 'Ramsay High School', '2026-08-25T00:00:00+00:00'),
      ('robinson-elementary-school', 'Robinson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('smith-middle-school', 'Smith Middle School', '2026-08-25T00:00:00+00:00'),
      ('tuggle-elementary-school', 'Tuggle Elementary School', '2026-08-25T00:00:00+00:00'),
      ('washington-k8', 'Washington K8', '2026-08-25T00:00:00+00:00'),
      ('jones-valley-middle-school', 'Jones Valley Middle School', '2026-08-25T00:00:00+00:00'),
      ('wenonah-high-school', 'Wenonah High School', '2026-08-25T00:00:00+00:00'),
      ('wilkerson-middle-school', 'Wilkerson Middle School', '2026-08-25T00:00:00+00:00'),
      ('woodlawn-high-schoolmagnet', 'Woodlawn High Schoolmagnet', '2026-08-25T00:00:00+00:00'),
      ('wylam-elementary-school', 'Wylam Elementary School', '2026-08-25T00:00:00+00:00'),
      ('city-elementary', 'City Elementary', '2026-08-25T00:00:00+00:00'),
      ('dupuy-alternative-school', 'Dupuy Alternative School', '2026-08-25T00:00:00+00:00'),
      ('adolescent-day-treatment', 'Adolescent Day Treatment', '2026-08-25T00:00:00+00:00'),
      ('south-hampton-k8', 'South Hampton K8', '2026-08-25T00:00:00+00:00'),
      ('martha-gaskins-k5', 'Martha Gaskins K5', '2026-08-25T00:00:00+00:00'),
      ('george-washington-carver-high-school', 'George Washington Carver High School', '2026-08-25T00:00:00+00:00'),
      ('glen-iris-elementary-school', 'Glen Iris Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sun-valley-elementary-school', 'Sun Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('homebound-elementary-school', 'Homebound Elementary School', '2026-08-25T00:00:00+00:00'),
      ('homebound-high-school', 'Homebound High School', '2026-08-25T00:00:00+00:00'),
      ('ossie-ware-mitchell-middle-school', 'Ossie Ware Mitchell Middle School', '2026-08-25T00:00:00+00:00'),
      ('phillips-academy', 'Phillips Academy', '2026-08-25T00:00:00+00:00'),
      ('huffman-academy', 'Huffman Academy', '2026-08-25T00:00:00+00:00'),
      ('west-end-academy', 'West End Academy', '2026-08-25T00:00:00+00:00'),
      ('bush-hills-steam-academy', 'Bush Hills Steam Academy', '2026-08-25T00:00:00+00:00'),
      ('hayes-k8', 'Hayes K8', '2026-08-25T00:00:00+00:00'),
      ('oxmoor-k5', 'Oxmoor K5', '2026-08-25T00:00:00+00:00'),
      ('richard-arrington-elementary', 'Richard Arrington Elementary', '2026-08-25T00:00:00+00:00'),
      ('bcs-virtual-academy-of-learning', 'Bcs Virtual Academy Of Learning', '2026-08-25T00:00:00+00:00'),
      ('hayden-elementary-school', 'Hayden Elementary School', '2026-08-25T00:00:00+00:00'),
      ('appalachian-school', 'Appalachian  School', '2026-08-25T00:00:00+00:00'),
      ('blountsville-elementary-school', 'Blountsville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cleveland-high-school', 'Cleveland High School', '2026-08-25T00:00:00+00:00'),
      ('hayden-primary-school', 'Hayden Primary School', '2026-08-25T00:00:00+00:00'),
      ('hayden-high-school', 'Hayden High School', '2026-08-25T00:00:00+00:00'),
      ('jb-pennington-high-school', 'Jb Pennington High School', '2026-08-25T00:00:00+00:00'),
      ('locust-fork-high-school', 'Locust Fork High School', '2026-08-25T00:00:00+00:00'),
      ('southeastern-school', 'Southeastern School', '2026-08-25T00:00:00+00:00'),
      ('susan-moore-high-school', 'Susan Moore High School', '2026-08-25T00:00:00+00:00'),
      ('allgood-alternative-school', 'Allgood Alternative School', '2026-08-25T00:00:00+00:00'),
      ('blount-county-learning-center', 'Blount County Learning Center', '2026-08-25T00:00:00+00:00'),
      ('blount-county-career-technical-center', 'Blount County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('locust-fork-elementary', 'Locust Fork Elementary', '2026-08-25T00:00:00+00:00'),
      ('cleveland-elementary-school', 'Cleveland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('susan-moore-elementary-school', 'Susan Moore Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hayden-middle-school', 'Hayden Middle School', '2026-08-25T00:00:00+00:00'),
      ('brewton-elementary-school', 'Brewton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('brewton-middle-school', 'Brewton Middle School', '2026-08-25T00:00:00+00:00'),
      ('tr-miller-high-school', 'Tr Miller High School', '2026-08-25T00:00:00+00:00'),
      ('bullock-county-high-school', 'Bullock County High School', '2026-08-25T00:00:00+00:00'),
      ('south-highlands-middle-school', 'South Highlands Middle School', '2026-08-25T00:00:00+00:00'),
      ('union-springs-elementary-school', 'Union Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bullock-county-career-technical-center', 'Bullock County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('greenville-high-school', 'Greenville High School', '2026-08-25T00:00:00+00:00'),
      ('greenville-middle-school', 'Greenville Middle School', '2026-08-25T00:00:00+00:00'),
      ('mckenzie-high-school', 'Mckenzie High School', '2026-08-25T00:00:00+00:00'),
      ('wo-parmer-elementary-school', 'Wo Parmer Elementary School', '2026-08-25T00:00:00+00:00'),
      ('butler-county-area-vocational-school', 'Butler County Area Vocational School', '2026-08-25T00:00:00+00:00'),
      ('greenville-elementary-school', 'Greenville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('georgiana-school', 'Georgiana School', '2026-08-25T00:00:00+00:00'),
      ('alexandria-high-school', 'Alexandria High School', '2026-08-25T00:00:00+00:00'),
      ('ohatchee-high-school', 'Ohatchee High School', '2026-08-25T00:00:00+00:00'),
      ('saks-elementary-school', 'Saks Elementary School', '2026-08-25T00:00:00+00:00'),
      ('saks-high-school', 'Saks High School', '2026-08-25T00:00:00+00:00'),
      ('saks-middle-school', 'Saks Middle School', '2026-08-25T00:00:00+00:00'),
      ('weaver-elementary-school', 'Weaver Elementary School', '2026-08-25T00:00:00+00:00'),
      ('weaver-high-school', 'Weaver High School', '2026-08-25T00:00:00+00:00'),
      ('wellborn-elementary-school', 'Wellborn Elementary School', '2026-08-25T00:00:00+00:00'),
      ('white-plains-high-school', 'White Plains High School', '2026-08-25T00:00:00+00:00'),
      ('calhoun-county-alternative-school', 'Calhoun County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('calhoun-county-career-technical-center', 'Calhoun County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('ohatchee-elementary-school', 'Ohatchee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pleasant-valley-elementary-school', 'Pleasant Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('white-plains-elementary-school', 'White Plains Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pleasant-valley-high-school', 'Pleasant Valley High School', '2026-08-25T00:00:00+00:00'),
      ('wellborn-high-school', 'Wellborn High School', '2026-08-25T00:00:00+00:00'),
      ('alexandria-elementary-school', 'Alexandria Elementary School', '2026-08-25T00:00:00+00:00'),
      ('white-plains-middle-school', 'White Plains Middle School', '2026-08-25T00:00:00+00:00'),
      ('alexandria-middle-school', 'Alexandria Middle School', '2026-08-25T00:00:00+00:00'),
      ('lafayette-eastside-elementary-school', 'Lafayette Eastside Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fairfax-elementary-school', 'Fairfax Elementary School', '2026-08-25T00:00:00+00:00'),
      ('five-points-elementary-school', 'Five Points Elementary School', '2026-08-25T00:00:00+00:00'),
      ('huguley-elementary-school', 'Huguley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lafayette-high-school', 'Lafayette High School', '2026-08-25T00:00:00+00:00'),
      ('lafayette-lanier-elementary-school', 'Lafayette Lanier Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bob-hardingshawmut-elementary', 'Bob Hardingshawmut Elementary', '2026-08-25T00:00:00+00:00'),
      ('john-p-powell-middle-school', 'John P Powell Middle School', '2026-08-25T00:00:00+00:00'),
      ('valley-high-school', 'Valley High School', '2026-08-25T00:00:00+00:00'),
      ('w-f-burns-middle-school', 'W F Burns Middle School', '2026-08-25T00:00:00+00:00'),
      ('inspire-academy', 'Inspire Academy', '2026-08-25T00:00:00+00:00'),
      ('inspire-virtual-academy', 'Inspire Virtual Academy', '2026-08-25T00:00:00+00:00'),
      ('cedar-bluff-high-school', 'Cedar Bluff High School', '2026-08-25T00:00:00+00:00'),
      ('centre-elementary-school', 'Centre Elementary School', '2026-08-25T00:00:00+00:00'),
      ('centre-middle-school', 'Centre Middle School', '2026-08-25T00:00:00+00:00'),
      ('cherokee-county-high-school', 'Cherokee County High School', '2026-08-25T00:00:00+00:00'),
      ('gaylesville-high-school', 'Gaylesville High School', '2026-08-25T00:00:00+00:00'),
      ('sand-rock-high-school', 'Sand Rock High School', '2026-08-25T00:00:00+00:00'),
      ('spring-garden-high-school', 'Spring Garden High School', '2026-08-25T00:00:00+00:00'),
      ('cherokee-county-career-technology-center', 'Cherokee County Career  Technology Center', '2026-08-25T00:00:00+00:00'),
      ('isabella-high-school', 'Isabella High School', '2026-08-25T00:00:00+00:00'),
      ('jemison-high-school', 'Jemison High School', '2026-08-25T00:00:00+00:00'),
      ('maplesville-high-school', 'Maplesville High School', '2026-08-25T00:00:00+00:00'),
      ('thorsby-high-school', 'Thorsby High School', '2026-08-25T00:00:00+00:00'),
      ('clanton-elementary-school', 'Clanton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('clanton-middle-school', 'Clanton Middle School', '2026-08-25T00:00:00+00:00'),
      ('verbena-high-school', 'Verbena High School', '2026-08-25T00:00:00+00:00'),
      ('jemison-middle-school', 'Jemison Middle School', '2026-08-25T00:00:00+00:00'),
      ('w-a-lecroy-career-technical-center', 'W A Lecroy Career  Technical Center', '2026-08-25T00:00:00+00:00'),
      ('clanton-intermediate-school', 'Clanton Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('chilton-county-high-school', 'Chilton County High School', '2026-08-25T00:00:00+00:00'),
      ('jemison-elementary-school', 'Jemison Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chilton-county-alternative-school', 'Chilton County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('jemison-intermediate-school', 'Jemison Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('southern-choctaw-elementary-school', 'Southern Choctaw Elementary School', '2026-08-25T00:00:00+00:00'),
      ('choctaw-county-high-school', 'Choctaw County High School', '2026-08-25T00:00:00+00:00'),
      ('southern-choctaw-high-school', 'Southern Choctaw High School', '2026-08-25T00:00:00+00:00'),
      ('choctaw-county-elementary', 'Choctaw County Elementary', '2026-08-25T00:00:00+00:00'),
      ('clarke-county-high-school', 'Clarke County High School', '2026-08-25T00:00:00+00:00'),
      ('grove-hill-elementary-school', 'Grove Hill Elementary School', '2026-08-25T00:00:00+00:00'),
      ('jackson-middle-school', 'Jackson Middle School', '2026-08-25T00:00:00+00:00'),
      ('joe-m-gillmore-elementary-school', 'Joe M Gillmore Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wilson-hall-middle-school', 'Wilson Hall Middle School', '2026-08-25T00:00:00+00:00'),
      ('jackson-intermediate-school', 'Jackson Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('jackson-high-school', 'Jackson High School', '2026-08-25T00:00:00+00:00'),
      ('ashland-elementary-school', 'Ashland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lineville-elementary-school', 'Lineville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('central-jr-high-school-of-clay-county', 'Central Jr High School Of Clay County', '2026-08-25T00:00:00+00:00'),
      ('central-high-school-of-clay-county', 'Central High School Of Clay County', '2026-08-25T00:00:00+00:00'),
      ('cleburne-county-elementary-school', 'Cleburne County Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cleburne-county-high-school', 'Cleburne County High School', '2026-08-25T00:00:00+00:00'),
      ('fruithurst-elementary-school', 'Fruithurst Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pleasant-grove-elementary-school', 'Pleasant Grove Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ranburne-high-school', 'Ranburne High School', '2026-08-25T00:00:00+00:00'),
      ('cleburne-county-career-technical-school', 'Cleburne County Career Technical School', '2026-08-25T00:00:00+00:00'),
      ('cleburne-county-middle-school', 'Cleburne County Middle School', '2026-08-25T00:00:00+00:00'),
      ('ranburne-elementary-school', 'Ranburne Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cleburne-county-alternative-school', 'Cleburne County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('kinston-school', 'Kinston School', '2026-08-25T00:00:00+00:00'),
      ('zion-chapel-high-school', 'Zion Chapel High School', '2026-08-25T00:00:00+00:00'),
      ('new-brockton-high-school', 'New Brockton High School', '2026-08-25T00:00:00+00:00'),
      ('new-brockton-elementary-school', 'New Brockton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('new-brockton-middle-school', 'New Brockton Middle School', '2026-08-25T00:00:00+00:00'),
      ('cherokee-elementary-school', 'Cherokee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cherokee-high-school', 'Cherokee High School', '2026-08-25T00:00:00+00:00'),
      ('colbert-county-high-school', 'Colbert County High School', '2026-08-25T00:00:00+00:00'),
      ('colbert-heights-high-school', 'Colbert Heights High School', '2026-08-25T00:00:00+00:00'),
      ('hatton-elementary-school', 'Hatton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('leighton-elementary-school', 'Leighton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('new-bethel-elementary-school', 'New Bethel Elementary School', '2026-08-25T00:00:00+00:00'),
      ('colbert-heights-elementary-school', 'Colbert Heights Elementary School', '2026-08-25T00:00:00+00:00'),
      ('conecuh-county-junior-high-school', 'Conecuh County Junior High School', '2026-08-25T00:00:00+00:00'),
      ('evergreen-elementary-school', 'Evergreen Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lyeffion-junior-high-school', 'Lyeffion Junior High School', '2026-08-25T00:00:00+00:00'),
      ('thurgood-marshall-middle-school', 'Thurgood Marshall Middle School', '2026-08-25T00:00:00+00:00'),
      ('repton-junior-high-school', 'Repton Junior High School', '2026-08-25T00:00:00+00:00'),
      ('hillcrest-high-school', 'Hillcrest High School', '2026-08-25T00:00:00+00:00'),
      ('genesis-school', 'Genesis School', '2026-08-25T00:00:00+00:00'),
      ('genesis-innovative-school', 'Genesis Innovative School', '2026-08-25T00:00:00+00:00'),
      ('conecuh-county-area-vocational-center', 'Conecuh County Area Vocational Center', '2026-08-25T00:00:00+00:00'),
      ('central-high-school', 'Central High School', '2026-08-25T00:00:00+00:00'),
      ('central-elementary-school', 'Central Elementary School', '2026-08-25T00:00:00+00:00'),
      ('straughn-elementary-school', 'Straughn Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fleeta-school', 'Fleeta School', '2026-08-25T00:00:00+00:00'),
      ('florala-high-school', 'Florala High School', '2026-08-25T00:00:00+00:00'),
      ('pleasant-home-school', 'Pleasant Home School', '2026-08-25T00:00:00+00:00'),
      ('straughn-high-school', 'Straughn High School', '2026-08-25T00:00:00+00:00'),
      ('ws-harlan-elementary-school', 'Ws Harlan Elementary School', '2026-08-25T00:00:00+00:00'),
      ('straughn-middle-school', 'Straughn Middle School', '2026-08-25T00:00:00+00:00'),
      ('red-level-school', 'Red Level School', '2026-08-25T00:00:00+00:00'),
      ('brantley-high-school', 'Brantley High School', '2026-08-25T00:00:00+00:00'),
      ('highland-home-school', 'Highland Home School', '2026-08-25T00:00:00+00:00'),
      ('luverne-high-school', 'Luverne High School', '2026-08-25T00:00:00+00:00'),
      ('crenshaw-county-career-academy', 'Crenshaw County Career Academy', '2026-08-25T00:00:00+00:00'),
      ('cullman-city-primary-school', 'Cullman City Primary School', '2026-08-25T00:00:00+00:00'),
      ('cullman-middle-school', 'Cullman Middle School', '2026-08-25T00:00:00+00:00'),
      ('cullman-high-school', 'Cullman High School', '2026-08-25T00:00:00+00:00'),
      ('east-elementary-school', 'East Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-elementary-school', 'West Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cullman-city-career-tech', 'Cullman City Career Tech', '2026-08-25T00:00:00+00:00'),
      ('cullman-community-comprehensive-learning-center', 'Cullman Community Comprehensive Learning Center', '2026-08-25T00:00:00+00:00'),
      ('parkside-elementary-school', 'Parkside Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cold-springs-high-school', 'Cold Springs High School', '2026-08-25T00:00:00+00:00'),
      ('cold-springs-elementary-school', 'Cold Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fairview-high-school', 'Fairview High School', '2026-08-25T00:00:00+00:00'),
      ('good-hope-high-school', 'Good Hope High School', '2026-08-25T00:00:00+00:00'),
      ('hanceville-high-school', 'Hanceville High School', '2026-08-25T00:00:00+00:00'),
      ('holly-pond-high-school', 'Holly Pond High School', '2026-08-25T00:00:00+00:00'),
      ('vinemont-high-school', 'Vinemont High School', '2026-08-25T00:00:00+00:00'),
      ('welti-elementary-school', 'Welti Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-point-high-school', 'West Point High School', '2026-08-25T00:00:00+00:00'),
      ('fairview-elementary-school', 'Fairview Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fairview-middle-school', 'Fairview Middle School', '2026-08-25T00:00:00+00:00'),
      ('good-hope-elementary-school', 'Good Hope Elementary School', '2026-08-25T00:00:00+00:00'),
      ('good-hope-middle-school', 'Good Hope Middle School', '2026-08-25T00:00:00+00:00'),
      ('hanceville-elementary-school', 'Hanceville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hanceville-middle-school', 'Hanceville Middle School', '2026-08-25T00:00:00+00:00'),
      ('holly-pond-elementary-school', 'Holly Pond Elementary School', '2026-08-25T00:00:00+00:00'),
      ('vinemont-elementary-school', 'Vinemont Elementary School', '2026-08-25T00:00:00+00:00'),
      ('vinemont-middle-school', 'Vinemont Middle School', '2026-08-25T00:00:00+00:00'),
      ('west-point-elementary-school', 'West Point Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-point-middle-school', 'West Point Middle School', '2026-08-25T00:00:00+00:00'),
      ('cullman-area-technology-academy', 'Cullman Area Technology Academy', '2026-08-25T00:00:00+00:00'),
      ('good-hope-primary-school', 'Good Hope Primary School', '2026-08-25T00:00:00+00:00'),
      ('cullman-child-development-center', 'Cullman Child Development Center', '2026-08-25T00:00:00+00:00'),
      ('cullman-area-resource-education', 'Cullman Area Resource Education', '2026-08-25T00:00:00+00:00'),
      ('harmony-school', 'Harmony School', '2026-08-25T00:00:00+00:00'),
      ('west-point-intermediate-school', 'West Point Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('gw-long-elementary-school', 'Gw Long Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ariton-school', 'Ariton School', '2026-08-25T00:00:00+00:00'),
      ('dale-county-high-school', 'Dale County High School', '2026-08-25T00:00:00+00:00'),
      ('george-w-long-high-school', 'George W Long High School', '2026-08-25T00:00:00+00:00'),
      ('midland-city-elementary-school', 'Midland City Elementary School', '2026-08-25T00:00:00+00:00'),
      ('newton-elementary-school', 'Newton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('south-dale-middle-school', 'South Dale Middle School', '2026-08-25T00:00:00+00:00'),
      ('opportunity-academy', 'Opportunity Academy', '2026-08-25T00:00:00+00:00'),
      ('bridge-academy', 'Bridge Academy', '2026-08-25T00:00:00+00:00'),
      ('daleville-high-school', 'Daleville High School', '2026-08-25T00:00:00+00:00'),
      ('a-m-windham-elementary-school', 'A M Windham Elementary School', '2026-08-25T00:00:00+00:00'),
      ('daleville-middle-school', 'Daleville Middle School', '2026-08-25T00:00:00+00:00'),
      ('brantley-elementary-school', 'Brantley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dallas-county-high-school', 'Dallas County High School', '2026-08-25T00:00:00+00:00'),
      ('je-terry-elementary-school', 'Je Terry Elementary School', '2026-08-25T00:00:00+00:00'),
      ('keith-middlehigh-school', 'Keith Middlehigh School', '2026-08-25T00:00:00+00:00'),
      ('salem-elementary-school', 'Salem Elementary School', '2026-08-25T00:00:00+00:00'),
      ('southside-high-school', 'Southside High School', '2026-08-25T00:00:00+00:00'),
      ('southside-primary-school', 'Southside Primary School', '2026-08-25T00:00:00+00:00'),
      ('tipton-durant-middle-school', 'Tipton Durant Middle School', '2026-08-25T00:00:00+00:00'),
      ('valley-grande-elementary-school', 'Valley Grande Elementary School', '2026-08-25T00:00:00+00:00'),
      ('william-r-martin-middle-school', 'William R Martin Middle School', '2026-08-25T00:00:00+00:00'),
      ('dallas-county-career-technical-center', 'Dallas County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('bruce-k-craig-elementary-school', 'Bruce K Craig Elementary School', '2026-08-25T00:00:00+00:00'),
      ('collinsville-high-school', 'Collinsville High School', '2026-08-25T00:00:00+00:00'),
      ('crossville-elementary-school', 'Crossville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fyffe-high-school', 'Fyffe High School', '2026-08-25T00:00:00+00:00'),
      ('geraldine-school', 'Geraldine School', '2026-08-25T00:00:00+00:00'),
      ('henagar-junior-high-school', 'Henagar Junior High School', '2026-08-25T00:00:00+00:00'),
      ('ider-school', 'Ider School', '2026-08-25T00:00:00+00:00'),
      ('plainview-school', 'Plainview School', '2026-08-25T00:00:00+00:00'),
      ('ruhuma-junior-high-school', 'Ruhuma Junior High School', '2026-08-25T00:00:00+00:00'),
      ('sylvania-school', 'Sylvania School', '2026-08-25T00:00:00+00:00'),
      ('valley-head-high-school', 'Valley Head High School', '2026-08-25T00:00:00+00:00'),
      ('alternative-school', 'Alternative School', '2026-08-25T00:00:00+00:00'),
      ('dekalb-annex-school', 'Dekalb Annex School', '2026-08-25T00:00:00+00:00'),
      ('dekalb-technical-center', 'Dekalb Technical Center', '2026-08-25T00:00:00+00:00'),
      ('crossville-high-school', 'Crossville High School', '2026-08-25T00:00:00+00:00'),
      ('crossville-middle-school', 'Crossville Middle School', '2026-08-25T00:00:00+00:00'),
      ('austin-middle-school', 'Austin Middle School', '2026-08-25T00:00:00+00:00'),
      ('austin-high-school', 'Austin High School', '2026-08-25T00:00:00+00:00'),
      ('austinville-elementary-school', 'Austinville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('decatur-high-school', 'Decatur High School', '2026-08-25T00:00:00+00:00'),
      ('eastwood-elementary-school', 'Eastwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('leon-sheffield-magnet-elementary-school', 'Leon Sheffield Magnet Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bankscaddell-elementary-school', 'Bankscaddell Elementary School', '2026-08-25T00:00:00+00:00'),
      ('decatur-middle-school', 'Decatur Middle School', '2026-08-25T00:00:00+00:00'),
      ('oak-park-elementary-school', 'Oak Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-decatur-elementary-school', 'West Decatur Elementary School', '2026-08-25T00:00:00+00:00'),
      ('walter-jackson-elementary-school', 'Walter Jackson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('benjamin-davis-elementary-school', 'Benjamin Davis Elementary School', '2026-08-25T00:00:00+00:00'),
      ('woodmeade-elementary-school', 'Woodmeade Elementary School', '2026-08-25T00:00:00+00:00'),
      ('frances-nungester-elementary-school', 'Frances Nungester Elementary School', '2026-08-25T00:00:00+00:00'),
      ('long-term-case', 'Long Term Case', '2026-08-25T00:00:00+00:00'),
      ('julian-harris-elementary-school', 'Julian Harris Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chestnut-grove-elementary-school', 'Chestnut Grove Elementary School', '2026-08-25T00:00:00+00:00'),
      ('decatur-high-developmental', 'Decatur High Developmental', '2026-08-25T00:00:00+00:00'),
      ('austin-junior-high-school', 'Austin Junior High School', '2026-08-25T00:00:00+00:00'),
      ('career-technical-center', 'Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('demopolis-high-school', 'Demopolis High School', '2026-08-25T00:00:00+00:00'),
      ('demopolis-middle-school', 'Demopolis Middle School', '2026-08-25T00:00:00+00:00'),
      ('us-jones-elementary-school', 'Us Jones Elementary School', '2026-08-25T00:00:00+00:00'),
      ('westside-elementary-school', 'Westside Elementary School', '2026-08-25T00:00:00+00:00'),
      ('carver-school-of-mathematics-science-and-technology', 'Carver School Of Mathematics Science And Technology', '2026-08-25T00:00:00+00:00'),
      ('girard-intermediate-school', 'Girard Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('girard-primary-school', 'Girard Primary School', '2026-08-25T00:00:00+00:00'),
      ('heard-elementary-school', 'Heard Elementary School', '2026-08-25T00:00:00+00:00'),
      ('selma-street-elementary-school', 'Selma Street Elementary School', '2026-08-25T00:00:00+00:00'),
      ('faine-elementary-school', 'Faine Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pass-academy', 'Pass Academy', '2026-08-25T00:00:00+00:00'),
      ('dothan-technology-center', 'Dothan Technology Center', '2026-08-25T00:00:00+00:00'),
      ('hidden-lake-primary-school', 'Hidden Lake Primary School', '2026-08-25T00:00:00+00:00'),
      ('highlands-elementary-school', 'Highlands Elementary School', '2026-08-25T00:00:00+00:00'),
      ('morris-slingluff-elementary-school', 'Morris Slingluff Elementary School', '2026-08-25T00:00:00+00:00'),
      ('beverlye-intermediate-school', 'Beverlye Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('dothan-high-school', 'Dothan High School', '2026-08-25T00:00:00+00:00'),
      ('kelly-springs-elementary-school', 'Kelly Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dothan-preparatory-academy', 'Dothan Preparatory Academy', '2026-08-25T00:00:00+00:00'),
      ('dothan-city-early-education-center', 'Dothan City Early Education Center', '2026-08-25T00:00:00+00:00'),
      ('dothan-city-virtual-school', 'Dothan City Virtual School', '2026-08-25T00:00:00+00:00'),
      ('carver-9th-grade-academy', 'Carver 9Th Grade Academy', '2026-08-25T00:00:00+00:00'),
      ('elba-elementary-school', 'Elba Elementary School', '2026-08-25T00:00:00+00:00'),
      ('elba-high-school', 'Elba High School', '2026-08-25T00:00:00+00:00'),
      ('elba-area-vocational-school', 'Elba Area Vocational School', '2026-08-25T00:00:00+00:00'),
      ('wetumpka-middle-school', 'Wetumpka Middle School', '2026-08-25T00:00:00+00:00'),
      ('elmore-county-high-school', 'Elmore County High School', '2026-08-25T00:00:00+00:00'),
      ('holtville-high-school', 'Holtville High School', '2026-08-25T00:00:00+00:00'),
      ('stanhope-elmore-high-school', 'Stanhope Elmore High School', '2026-08-25T00:00:00+00:00'),
      ('wetumpka-elementary-school', 'Wetumpka Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wetumpka-high-school', 'Wetumpka High School', '2026-08-25T00:00:00+00:00'),
      ('coosada-elementary-school', 'Coosada Elementary School', '2026-08-25T00:00:00+00:00'),
      ('elmore-county-technical-center', 'Elmore County Technical Center', '2026-08-25T00:00:00+00:00'),
      ('eclectic-middle-school', 'Eclectic Middle School', '2026-08-25T00:00:00+00:00'),
      ('holtville-middle-school', 'Holtville Middle School', '2026-08-25T00:00:00+00:00'),
      ('millbrook-middle-school', 'Millbrook Middle School', '2026-08-25T00:00:00+00:00'),
      ('eclectic-elementary-school', 'Eclectic Elementary School', '2026-08-25T00:00:00+00:00'),
      ('holtville-elementary-school', 'Holtville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('redland-elementary-school', 'Redland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('airport-road-intermediate-school', 'Airport Road Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('edge-virtual-school', 'Edge Virtual School', '2026-08-25T00:00:00+00:00'),
      ('redland-middle-school', 'Redland Middle School', '2026-08-25T00:00:00+00:00'),
      ('coppinville-school', 'Coppinville School', '2026-08-25T00:00:00+00:00'),
      ('dauphin-junior-high-school', 'Dauphin Junior High School', '2026-08-25T00:00:00+00:00'),
      ('enterprise-high-school', 'Enterprise High School', '2026-08-25T00:00:00+00:00'),
      ('hillcrest-elementary-school', 'Hillcrest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('holly-hill-elementary-school', 'Holly Hill Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pinedale-elementary-school', 'Pinedale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('rucker-boulevard-elementary-school', 'Rucker Boulevard Elementary School', '2026-08-25T00:00:00+00:00'),
      ('harrand-creek-elementary-school', 'Harrand Creek Elementary School', '2026-08-25T00:00:00+00:00'),
      ('brookwood-elementary-school', 'Brookwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('enterprise-career-and-technology-center', 'Enterprise Career And Technology Center', '2026-08-25T00:00:00+00:00'),
      ('escambia-county-high-school', 'Escambia County High School', '2026-08-25T00:00:00+00:00'),
      ('escambia-county-middle-school', 'Escambia County Middle School', '2026-08-25T00:00:00+00:00'),
      ('flomaton-high-school', 'Flomaton High School', '2026-08-25T00:00:00+00:00'),
      ('huxford-elementary-school', 'Huxford Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pollardmccall-junior-high-school', 'Pollardmccall Junior High School', '2026-08-25T00:00:00+00:00'),
      ('w-s-neal-high-school', 'W S Neal High School', '2026-08-25T00:00:00+00:00'),
      ('escambia-county-alternative-school', 'Escambia County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('escambiabrewton-career-technical-center', 'Escambiabrewton Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('flomaton-elementary-school', 'Flomaton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('w-s-neal-elementary-school', 'W S Neal Elementary School', '2026-08-25T00:00:00+00:00'),
      ('w-s-neal-middle-school', 'W S Neal Middle School', '2026-08-25T00:00:00+00:00'),
      ('rachel-patterson-elementary-school', 'Rachel Patterson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('carlisle-elementary-school', 'Carlisle Elementary School', '2026-08-25T00:00:00+00:00'),
      ('duck-springs-elementary-school', 'Duck Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('gaston-high-school', 'Gaston High School', '2026-08-25T00:00:00+00:00'),
      ('glencoe-elementary-school', 'Glencoe Elementary School', '2026-08-25T00:00:00+00:00'),
      ('glencoe-high-school', 'Glencoe High School', '2026-08-25T00:00:00+00:00'),
      ('hokes-bluff-elementary-school', 'Hokes Bluff Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hokes-bluff-middle-school', 'Hokes Bluff Middle School', '2026-08-25T00:00:00+00:00'),
      ('ivalee-elementary-school', 'Ivalee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('john-s-jones-elementary-school', 'John S Jones Elementary School', '2026-08-25T00:00:00+00:00'),
      ('highland-elementary-school', 'Highland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sardis-high-school', 'Sardis High School', '2026-08-25T00:00:00+00:00'),
      ('southside-high-school-2', 'Southside High School', '2026-08-25T00:00:00+00:00'),
      ('west-end-high-school', 'West End High School', '2026-08-25T00:00:00+00:00'),
      ('west-end-elementary-school', 'West End Elementary School', '2026-08-25T00:00:00+00:00'),
      ('whitesboro-elementary-school', 'Whitesboro Elementary School', '2026-08-25T00:00:00+00:00'),
      ('etowah-county-special-education-learning-center', 'Etowah County Special Education Learning Center', '2026-08-25T00:00:00+00:00'),
      ('the-etowah-county-refocus-center', 'The Etowah County Refocus Center', '2026-08-25T00:00:00+00:00'),
      ('career-technical-center-2', 'Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('glencoe-middle-school', 'Glencoe Middle School', '2026-08-25T00:00:00+00:00'),
      ('rainbow-middle-school', 'Rainbow Middle School', '2026-08-25T00:00:00+00:00'),
      ('southside-elementary-school', 'Southside Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hokes-bluff-high-school', 'Hokes Bluff High School', '2026-08-25T00:00:00+00:00'),
      ('sardis-middle-school', 'Sardis Middle School', '2026-08-25T00:00:00+00:00'),
      ('gaston-elementary-school', 'Gaston Elementary School', '2026-08-25T00:00:00+00:00'),
      ('eufaula-high-school', 'Eufaula High School', '2026-08-25T00:00:00+00:00'),
      ('moorer-middle-school', 'Moorer Middle School', '2026-08-25T00:00:00+00:00'),
      ('eufaula-primary-school', 'Eufaula Primary School', '2026-08-25T00:00:00+00:00'),
      ('eufaula-elementary-school', 'Eufaula Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hope-academy', 'Hope Academy', '2026-08-25T00:00:00+00:00'),
      ('alabama-virtual-academy-at-eufaula-city-schools', 'Alabama Virtual Academy At Eufaula City Schools', '2026-08-25T00:00:00+00:00'),
      ('c-j-donald-middle-school', 'C J Donald Middle School', '2026-08-25T00:00:00+00:00'),
      ('fairfield-high-preparatory-school', 'Fairfield High Preparatory School', '2026-08-25T00:00:00+00:00'),
      ('glen-oaks-elementary-school', 'Glen Oaks Elementary School', '2026-08-25T00:00:00+00:00'),
      ('robinson-primary-school', 'Robinson Primary School', '2026-08-25T00:00:00+00:00'),
      ('fairfield-alternative-school', 'Fairfield Alternative School', '2026-08-25T00:00:00+00:00'),
      ('fairfield-area-vocational-school', 'Fairfield Area Vocational School', '2026-08-25T00:00:00+00:00'),
      ('berry-high-school', 'Berry High School', '2026-08-25T00:00:00+00:00'),
      ('fayette-middle-school', 'Fayette Middle School', '2026-08-25T00:00:00+00:00'),
      ('hubbertville-school', 'Hubbertville School', '2026-08-25T00:00:00+00:00'),
      ('berry-elementary-school', 'Berry Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fayette-elementary-school', 'Fayette Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fayette-county-high-school', 'Fayette County High School', '2026-08-25T00:00:00+00:00'),
      ('florence-high-school', 'Florence High School', '2026-08-25T00:00:00+00:00'),
      ('florence-freshman-center', 'Florence Freshman Center', '2026-08-25T00:00:00+00:00'),
      ('forest-hills-school', 'Forest Hills School', '2026-08-25T00:00:00+00:00'),
      ('harlan-elementary-school', 'Harlan Elementary School', '2026-08-25T00:00:00+00:00'),
      ('weeden-elementary-school', 'Weeden Elementary School', '2026-08-25T00:00:00+00:00'),
      ('florence-middle-school', 'Florence Middle School', '2026-08-25T00:00:00+00:00'),
      ('florence-learning-center', 'Florence Learning Center', '2026-08-25T00:00:00+00:00'),
      ('hibbett-school', 'Hibbett School', '2026-08-25T00:00:00+00:00'),
      ('kilby-laboratory-school', 'Kilby Laboratory School', '2026-08-25T00:00:00+00:00'),
      ('fort-payne-high-school', 'Fort Payne High School', '2026-08-25T00:00:00+00:00'),
      ('williams-avenue-elementary-school', 'Williams Avenue Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wills-valley-elementary-school', 'Wills Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fort-payne-middle-school', 'Fort Payne Middle School', '2026-08-25T00:00:00+00:00'),
      ('little-ridge-intermediate-school', 'Little Ridge Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('belgreen-high-school', 'Belgreen High School', '2026-08-25T00:00:00+00:00'),
      ('east-franklin-junior-high-school', 'East Franklin Junior High School', '2026-08-25T00:00:00+00:00'),
      ('phil-campbell-high-school', 'Phil Campbell High School', '2026-08-25T00:00:00+00:00'),
      ('red-bay-high-school', 'Red Bay High School', '2026-08-25T00:00:00+00:00'),
      ('tharptown-elementary-school', 'Tharptown Elementary School', '2026-08-25T00:00:00+00:00'),
      ('vina-high-school', 'Vina High School', '2026-08-25T00:00:00+00:00'),
      ('franklin-county-career-technical-center', 'Franklin County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('phil-campbell-elementary-school', 'Phil Campbell Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tharptown-high-school', 'Tharptown High School', '2026-08-25T00:00:00+00:00'),
      ('red-bay-elementary', 'Red Bay Elementary', '2026-08-25T00:00:00+00:00'),
      ('donehoo-elementary-school', 'Donehoo Elementary School', '2026-08-25T00:00:00+00:00'),
      ('litchfield-middle-school', 'Litchfield Middle School', '2026-08-25T00:00:00+00:00'),
      ('gadsden-middle-school', 'Gadsden Middle School', '2026-08-25T00:00:00+00:00'),
      ('eura-brown-elementary-school', 'Eura Brown Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sansom-middle-school', 'Sansom Middle School', '2026-08-25T00:00:00+00:00'),
      ('mitchell-elementary-school', 'Mitchell Elementary School', '2026-08-25T00:00:00+00:00'),
      ('w-e-striplin-elementary-school', 'W E Striplin Elementary School', '2026-08-25T00:00:00+00:00'),
      ('walnut-park-elementary-school', 'Walnut Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('c-i-t-y-program', 'C I T Y Program', '2026-08-25T00:00:00+00:00'),
      ('floyd-elementary-school', 'Floyd Elementary School', '2026-08-25T00:00:00+00:00'),
      ('gadsden-city-alternative-school', 'Gadsden City Alternative School', '2026-08-25T00:00:00+00:00'),
      ('therapeutic-academic-program', 'Therapeutic Academic Program', '2026-08-25T00:00:00+00:00'),
      ('adams-elementary-school', 'Adams Elementary School', '2026-08-25T00:00:00+00:00'),
      ('thompson-elementary-school', 'Thompson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('gadsden-city-high-school', 'Gadsden City High School', '2026-08-25T00:00:00+00:00'),
      ('geneva-high-school', 'Geneva High School', '2026-08-25T00:00:00+00:00'),
      ('mulkey-elementary-school', 'Mulkey Elementary School', '2026-08-25T00:00:00+00:00'),
      ('geneva-middle-school', 'Geneva Middle School', '2026-08-25T00:00:00+00:00'),
      ('geneva-county-high-school', 'Geneva County High School', '2026-08-25T00:00:00+00:00'),
      ('samson-high-school', 'Samson High School', '2026-08-25T00:00:00+00:00'),
      ('slocomb-high-school', 'Slocomb High School', '2026-08-25T00:00:00+00:00'),
      ('samson-elementary-school', 'Samson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('samson-middle-school', 'Samson Middle School', '2026-08-25T00:00:00+00:00'),
      ('geneva-county-elementary-school', 'Geneva County Elementary School', '2026-08-25T00:00:00+00:00'),
      ('geneva-county-middle-school', 'Geneva County Middle School', '2026-08-25T00:00:00+00:00'),
      ('slocomb-elementary-school', 'Slocomb Elementary School', '2026-08-25T00:00:00+00:00'),
      ('slocomb-middle-school', 'Slocomb Middle School', '2026-08-25T00:00:00+00:00'),
      ('geneva-regional-career-technical-center', 'Geneva Regional Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('greene-county-high-school', 'Greene County High School', '2026-08-25T00:00:00+00:00'),
      ('peter-j-kirksey-career-center', 'Peter J Kirksey Career Center', '2026-08-25T00:00:00+00:00'),
      ('eutaw-primary-school', 'Eutaw Primary School', '2026-08-25T00:00:00+00:00'),
      ('robert-brown-middle-school', 'Robert Brown Middle School', '2026-08-25T00:00:00+00:00'),
      ('greene-county-career-center', 'Greene County Career Center', '2026-08-25T00:00:00+00:00'),
      ('guntersville-middle-school', 'Guntersville Middle School', '2026-08-25T00:00:00+00:00'),
      ('cherokee-elementary-school-2', 'Cherokee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('guntersville-elementary-school', 'Guntersville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('guntersville-high-school', 'Guntersville High School', '2026-08-25T00:00:00+00:00'),
      ('hale-county-high-school', 'Hale County High School', '2026-08-25T00:00:00+00:00'),
      ('moundville-elementary-school', 'Moundville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('college-and-career-academy', 'College And Career Academy', '2026-08-25T00:00:00+00:00'),
      ('greensboro-middle-school', 'Greensboro Middle School', '2026-08-25T00:00:00+00:00'),
      ('greensboro-elementary-school', 'Greensboro Elementary School', '2026-08-25T00:00:00+00:00'),
      ('greensboro-high-school', 'Greensboro High School', '2026-08-25T00:00:00+00:00'),
      ('hale-county-middle-school', 'Hale County Middle School', '2026-08-25T00:00:00+00:00'),
      ('haleyville-high-school', 'Haleyville High School', '2026-08-25T00:00:00+00:00'),
      ('haleyville-center-of-technology', 'Haleyville Center Of Technology', '2026-08-25T00:00:00+00:00'),
      ('haleyville-elementary-school', 'Haleyville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('haleyville-middle-school', 'Haleyville Middle School', '2026-08-25T00:00:00+00:00'),
      ('barkley-bridge-elementary-school', 'Barkley Bridge Elementary School', '2026-08-25T00:00:00+00:00'),
      ('crestline-elementary-school', 'Crestline Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fe-burleson-elementary-school', 'Fe Burleson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hartselle-junior-high-school', 'Hartselle Junior High School', '2026-08-25T00:00:00+00:00'),
      ('hartselle-high-school', 'Hartselle High School', '2026-08-25T00:00:00+00:00'),
      ('hartselle-intermediate-school', 'Hartselle Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('abbeville-high-school', 'Abbeville High School', '2026-08-25T00:00:00+00:00'),
      ('abbeville-elementary-school', 'Abbeville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('headland-elementary-school', 'Headland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('headland-high-school', 'Headland High School', '2026-08-25T00:00:00+00:00'),
      ('headland-middle-school', 'Headland Middle School', '2026-08-25T00:00:00+00:00'),
      ('henry-county-virtual-campus', 'Henry County Virtual Campus', '2026-08-25T00:00:00+00:00'),
      ('edgewood-elementary-school', 'Edgewood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hall-kent-elementary-school', 'Hall Kent Elementary School', '2026-08-25T00:00:00+00:00'),
      ('homewood-high-school', 'Homewood High School', '2026-08-25T00:00:00+00:00'),
      ('homewood-middle-school', 'Homewood Middle School', '2026-08-25T00:00:00+00:00'),
      ('shades-cahaba-elementary-school', 'Shades Cahaba Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ashford-high-school', 'Ashford High School', '2026-08-25T00:00:00+00:00'),
      ('cottonwood-high-school', 'Cottonwood High School', '2026-08-25T00:00:00+00:00'),
      ('houston-county-high-school', 'Houston County High School', '2026-08-25T00:00:00+00:00'),
      ('rehobeth-high-school', 'Rehobeth High School', '2026-08-25T00:00:00+00:00'),
      ('webb-elementary-school', 'Webb Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wicksburg-high-school', 'Wicksburg High School', '2026-08-25T00:00:00+00:00'),
      ('houston-county-alternative-school', 'Houston County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('houston-county-area-vocational-center', 'Houston County Area Vocational Center', '2026-08-25T00:00:00+00:00'),
      ('ashford-elementary-school', 'Ashford Elementary School', '2026-08-25T00:00:00+00:00'),
      ('rehobeth-middle-school', 'Rehobeth Middle School', '2026-08-25T00:00:00+00:00'),
      ('rehobeth-elementary-school', 'Rehobeth Elementary School', '2026-08-25T00:00:00+00:00'),
      ('houston-county-virtual-academy', 'Houston County Virtual Academy', '2026-08-25T00:00:00+00:00'),
      ('wicksburg-elementary-school', 'Wicksburg Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cottonwood-elementary-school', 'Cottonwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ashford-middle-school', 'Ashford Middle School', '2026-08-25T00:00:00+00:00'),
      ('hampton-cove-elementary', 'Hampton Cove Elementary', '2026-08-25T00:00:00+00:00'),
      ('blossomwood-elementary-school', 'Blossomwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('academy-for-academics-arts-elementary-school', 'Academy For Academics  Arts Elementary School', '2026-08-25T00:00:00+00:00'),
      ('roger-b-chaffee-elementary-school', 'Roger B Chaffee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chapman-elementary-school', 'Chapman Elementary School', '2026-08-25T00:00:00+00:00'),
      ('martin-luther-king-jr-elementary-school', 'Martin Luther King Jr Elementary School', '2026-08-25T00:00:00+00:00'),
      ('academy-for-science-foreign-language', 'Academy For Science  Foreign Language', '2026-08-25T00:00:00+00:00'),
      ('farley-elementary-school', 'Farley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('virgil-grissom-high-school', 'Virgil Grissom High School', '2026-08-25T00:00:00+00:00'),
      ('highlands-elementary-school-2', 'Highlands Elementary School', '2026-08-25T00:00:00+00:00'),
      ('huntsville-high-school', 'Huntsville High School', '2026-08-25T00:00:00+00:00'),
      ('huntsville-junior-high-school', 'Huntsville Junior High School', '2026-08-25T00:00:00+00:00'),
      ('jones-valley-elementary-school', 'Jones Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lakewood-elementary-school', 'Lakewood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lee-high-school', 'Lee High School', '2026-08-25T00:00:00+00:00'),
      ('mcdonnell-elementary-school', 'Mcdonnell Elementary School', '2026-08-25T00:00:00+00:00'),
      ('monte-sano-elementary-school', 'Monte Sano Elementary School', '2026-08-25T00:00:00+00:00'),
      ('montview-elementary-school', 'Montview Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mountain-gap-elementary-school', 'Mountain Gap Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ridgecrest-elementary-school', 'Ridgecrest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('rolling-hills-elementary-school', 'Rolling Hills Elementary School', '2026-08-25T00:00:00+00:00'),
      ('james-dawson-elementary', 'James Dawson Elementary', '2026-08-25T00:00:00+00:00'),
      ('weatherly-heights-elementary-school', 'Weatherly Heights Elementary School', '2026-08-25T00:00:00+00:00'),
      ('whitesburg-elementary-school', 'Whitesburg Elementary School', '2026-08-25T00:00:00+00:00'),
      ('new-century-technology-high-school', 'New Century Technology High School', '2026-08-25T00:00:00+00:00'),
      ('neavesdavis-detention-center-for-children', 'Neavesdavis Detention Center For Children', '2026-08-25T00:00:00+00:00'),
      ('huntsville-center-for-technology', 'Huntsville Center For Technology', '2026-08-25T00:00:00+00:00'),
      ('chapman-middle-school', 'Chapman Middle School', '2026-08-25T00:00:00+00:00'),
      ('morris-elementary-school', 'Morris Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mountain-gap-middle-school', 'Mountain Gap Middle School', '2026-08-25T00:00:00+00:00'),
      ('whitesburg-middle-school', 'Whitesburg Middle School', '2026-08-25T00:00:00+00:00'),
      ('columbia-high-school', 'Columbia High School', '2026-08-25T00:00:00+00:00'),
      ('mental-health-center', 'Mental Health Center', '2026-08-25T00:00:00+00:00'),
      ('challenger-elementary-school', 'Challenger Elementary School', '2026-08-25T00:00:00+00:00'),
      ('challenger-middle-school', 'Challenger Middle School', '2026-08-25T00:00:00+00:00'),
      ('williams-elementary-school', 'Williams Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hampton-cove-middle-school', 'Hampton Cove Middle School', '2026-08-25T00:00:00+00:00'),
      ('williams-middle-school', 'Williams Middle School', '2026-08-25T00:00:00+00:00'),
      ('providence-elementary', 'Providence Elementary', '2026-08-25T00:00:00+00:00'),
      ('goldsmithschiffman-elementary', 'Goldsmithschiffman Elementary', '2026-08-25T00:00:00+00:00'),
      ('ronald-mcnair-78', 'Ronald Mcnair 78', '2026-08-25T00:00:00+00:00'),
      ('jemison-high-school-2', 'Jemison High School', '2026-08-25T00:00:00+00:00'),
      ('sonnie-hereford-elementary-school', 'Sonnie Hereford Elementary School', '2026-08-25T00:00:00+00:00'),
      ('academy-for-academics-and-arts-middle-school', 'Academy For Academics And Arts Middle School', '2026-08-25T00:00:00+00:00'),
      ('morris-middle-school', 'Morris Middle School', '2026-08-25T00:00:00+00:00'),
      ('academy-for-science-foreign-language-middle-school', 'Academy For Science  Foreign Language Middle School', '2026-08-25T00:00:00+00:00'),
      ('bridgeport-elementary-school', 'Bridgeport Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bridgeport-middle-school', 'Bridgeport Middle School', '2026-08-25T00:00:00+00:00'),
      ('bryant-school', 'Bryant School', '2026-08-25T00:00:00+00:00'),
      ('dutton-elementary-school', 'Dutton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('flat-rock-school', 'Flat Rock School', '2026-08-25T00:00:00+00:00'),
      ('hollywood-elementary-school', 'Hollywood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('north-sand-mountain-school', 'North Sand Mountain School', '2026-08-25T00:00:00+00:00'),
      ('rosalie-elementary-school', 'Rosalie Elementary School', '2026-08-25T00:00:00+00:00'),
      ('section-high-school', 'Section High School', '2026-08-25T00:00:00+00:00'),
      ('skyline-high-school', 'Skyline High School', '2026-08-25T00:00:00+00:00'),
      ('woodville-high-school', 'Woodville High School', '2026-08-25T00:00:00+00:00'),
      ('jackson-county-alternative-school', 'Jackson County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('epruett-center-of-technology', 'Epruett Center Of Technology', '2026-08-25T00:00:00+00:00'),
      ('pisgah-high-school', 'Pisgah High School', '2026-08-25T00:00:00+00:00'),
      ('stevenson-elementary-school', 'Stevenson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('stevenson-middle-school', 'Stevenson Middle School', '2026-08-25T00:00:00+00:00'),
      ('macedonia-school', 'Macedonia School', '2026-08-25T00:00:00+00:00'),
      ('north-jackson-high-school', 'North Jackson High School', '2026-08-25T00:00:00+00:00'),
      ('kitty-stone-elementary-school', 'Kitty Stone Elementary School', '2026-08-25T00:00:00+00:00'),
      ('jacksonville-high-school', 'Jacksonville High School', '2026-08-25T00:00:00+00:00'),
      ('maddox-intermediate-school', 'Maddox Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('memorial-park-elementary-school', 'Memorial Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('t-r-simmons-elementary-school', 'T R Simmons Elementary School', '2026-08-25T00:00:00+00:00'),
      ('jasper-high-school', 'Jasper High School', '2026-08-25T00:00:00+00:00'),
      ('jasper-junior-high-school', 'Jasper Junior High School', '2026-08-25T00:00:00+00:00'),
      ('jefferson-county-counseling-learning-centereast', 'Jefferson County Counseling Learning Centereast', '2026-08-25T00:00:00+00:00'),
      ('claychalkville-high-school', 'Claychalkville High School', '2026-08-25T00:00:00+00:00'),
      ('claychalkville-middle-school', 'Claychalkville Middle School', '2026-08-25T00:00:00+00:00'),
      ('mcadory-elementary-school', 'Mcadory Elementary School', '2026-08-25T00:00:00+00:00'),
      ('adamsville-elementary-school', 'Adamsville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bagley-elementary-school', 'Bagley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('minor-middle-school', 'Minor Middle School', '2026-08-25T00:00:00+00:00'),
      ('bragg-middle-school', 'Bragg Middle School', '2026-08-25T00:00:00+00:00'),
      ('brighton-school', 'Brighton School', '2026-08-25T00:00:00+00:00'),
      ('brookville-elementary-school', 'Brookville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('center-point-elementary-school', 'Center Point Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chalkville-elementary-school', 'Chalkville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('clay-elementary-school', 'Clay Elementary School', '2026-08-25T00:00:00+00:00'),
      ('concord-elementary-school', 'Concord Elementary School', '2026-08-25T00:00:00+00:00'),
      ('corner-high-school', 'Corner High School', '2026-08-25T00:00:00+00:00'),
      ('uw-clemon-elementary-school', 'Uw Clemon Elementary School', '2026-08-25T00:00:00+00:00'),
      ('erwin-intermediate-school', 'Erwin Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('center-point-high-school', 'Center Point High School', '2026-08-25T00:00:00+00:00'),
      ('fultondale-elementary-school', 'Fultondale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('fultondale-high-school', 'Fultondale High School', '2026-08-25T00:00:00+00:00'),
      ('gardendale-elementary-school', 'Gardendale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('gardendale-high-school', 'Gardendale High School', '2026-08-25T00:00:00+00:00'),
      ('mccalla-elementary-school', 'Mccalla Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hueytown-intermediate-school', 'Hueytown Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('hueytown-high-school', 'Hueytown High School', '2026-08-25T00:00:00+00:00'),
      ('irondale-community-school', 'Irondale Community School', '2026-08-25T00:00:00+00:00'),
      ('bryan-elementary-school', 'Bryan Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lipscomb-elementary-school', 'Lipscomb Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mcadory-high-school', 'Mcadory High School', '2026-08-25T00:00:00+00:00'),
      ('minor-community-school', 'Minor Community School', '2026-08-25T00:00:00+00:00'),
      ('mortimer-jordan-high-school', 'Mortimer Jordan High School', '2026-08-25T00:00:00+00:00'),
      ('mount-olive-elementary-school', 'Mount Olive Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hueytown-primary-school', 'Hueytown Primary School', '2026-08-25T00:00:00+00:00'),
      ('oak-grove-high-school', 'Oak Grove High School', '2026-08-25T00:00:00+00:00'),
      ('pinson-elementary-school', 'Pinson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pinson-valley-high-school', 'Pinson Valley High School', '2026-08-25T00:00:00+00:00'),
      ('hueytown-middle-school', 'Hueytown Middle School', '2026-08-25T00:00:00+00:00'),
      ('pleasant-grove-elementary-school-2', 'Pleasant Grove Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pleasant-grove-high-school', 'Pleasant Grove High School', '2026-08-25T00:00:00+00:00'),
      ('snow-rogers-elementary-school', 'Snow Rogers Elementary School', '2026-08-25T00:00:00+00:00'),
      ('shades-valley-high-school', 'Shades Valley High School', '2026-08-25T00:00:00+00:00'),
      ('warrior-elementary-school', 'Warrior Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-jefferson-elementary-school', 'West Jefferson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('oak-grove-elementary-school', 'Oak Grove Elementary School', '2026-08-25T00:00:00+00:00'),
      ('grantswood-community-school', 'Grantswood Community School', '2026-08-25T00:00:00+00:00'),
      ('kermit-johnson-school', 'Kermit Johnson School', '2026-08-25T00:00:00+00:00'),
      ('rudd-middle-school', 'Rudd Middle School', '2026-08-25T00:00:00+00:00'),
      ('william-e-burkett-multihandicapped-center', 'William E Burkett Multihandicapped Center', '2026-08-25T00:00:00+00:00'),
      ('minor-high-school', 'Minor High School', '2026-08-25T00:00:00+00:00'),
      ('north-jefferson-middle-school', 'North Jefferson Middle School', '2026-08-25T00:00:00+00:00'),
      ('irondale-middle-school', 'Irondale Middle School', '2026-08-25T00:00:00+00:00'),
      ('mcadory-middle-school', 'Mcadory Middle School', '2026-08-25T00:00:00+00:00'),
      ('corner-middle-school', 'Corner Middle School', '2026-08-25T00:00:00+00:00'),
      ('erwin-middle-school', 'Erwin Middle School', '2026-08-25T00:00:00+00:00'),
      ('jefferson-county-international-baccalaureate-school', 'Jefferson County International Baccalaureate School', '2026-08-25T00:00:00+00:00'),
      ('bryant-park-elementary', 'Bryant Park Elementary', '2026-08-25T00:00:00+00:00'),
      ('jefferson-county-virtual-school', 'Jefferson County Virtual School', '2026-08-25T00:00:00+00:00'),
      ('sulligent-school', 'Sulligent School', '2026-08-25T00:00:00+00:00'),
      ('vernon-elementary-school', 'Vernon Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lamar-county-school-of-technology', 'Lamar County School Of Technology', '2026-08-25T00:00:00+00:00'),
      ('lamar-county-highintermediate', 'Lamar County Highintermediate', '2026-08-25T00:00:00+00:00'),
      ('south-lamar-school', 'South Lamar School', '2026-08-25T00:00:00+00:00'),
      ('lanett-senior-high-school', 'Lanett Senior High School', '2026-08-25T00:00:00+00:00'),
      ('lanett-junior-high-school', 'Lanett Junior High School', '2026-08-25T00:00:00+00:00'),
      ('w-o-lance-elementary', 'W O Lance Elementary', '2026-08-25T00:00:00+00:00'),
      ('allen-thornton-career-technical-center', 'Allen Thornton Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('brooks-high-school', 'Brooks High School', '2026-08-25T00:00:00+00:00'),
      ('central-high-school-2', 'Central High School', '2026-08-25T00:00:00+00:00'),
      ('lauderdale-county-high-school', 'Lauderdale County High School', '2026-08-25T00:00:00+00:00'),
      ('lexington-high-school', 'Lexington High School', '2026-08-25T00:00:00+00:00'),
      ('rogers-high-school', 'Rogers High School', '2026-08-25T00:00:00+00:00'),
      ('underwood-elementary-school', 'Underwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('waterloo-high-school', 'Waterloo High School', '2026-08-25T00:00:00+00:00'),
      ('wilson-high-school', 'Wilson High School', '2026-08-25T00:00:00+00:00'),
      ('brooks-elementary-school', 'Brooks Elementary School', '2026-08-25T00:00:00+00:00'),
      ('central-elementary-school-2', 'Central Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lauderdale-elementary-school', 'Lauderdale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lexington-elementary-school', 'Lexington Elementary School', '2026-08-25T00:00:00+00:00'),
      ('rogers-elementary-school', 'Rogers Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wilson-elementary-school', 'Wilson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('r-a-hubbard-high-school', 'R A Hubbard High School', '2026-08-25T00:00:00+00:00'),
      ('the-judy-jester-learning-center', 'The Judy Jester Learning Center', '2026-08-25T00:00:00+00:00'),
      ('east-lawrence-middle-school', 'East Lawrence Middle School', '2026-08-25T00:00:00+00:00'),
      ('hatton-elementary-school-2', 'Hatton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hatton-high-school', 'Hatton High School', '2026-08-25T00:00:00+00:00'),
      ('hazlewood-elementary-school', 'Hazlewood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lawrence-county-high-school', 'Lawrence County High School', '2026-08-25T00:00:00+00:00'),
      ('moulton-elementary-school', 'Moulton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('moulton-middle-school', 'Moulton Middle School', '2026-08-25T00:00:00+00:00'),
      ('mount-hope', 'Mount Hope', '2026-08-25T00:00:00+00:00'),
      ('speake', 'Speake', '2026-08-25T00:00:00+00:00'),
      ('lawrence-county-career-technical-center', 'Lawrence County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('east-lawrence-elementary-school', 'East Lawrence Elementary School', '2026-08-25T00:00:00+00:00'),
      ('east-lawrence-high-school', 'East Lawrence High School', '2026-08-25T00:00:00+00:00'),
      ('lawrence-county-developmental', 'Lawrence County Developmental', '2026-08-25T00:00:00+00:00'),
      ('beauregard-elementary-school', 'Beauregard Elementary School', '2026-08-25T00:00:00+00:00'),
      ('beulah-elementary-school', 'Beulah Elementary School', '2026-08-25T00:00:00+00:00'),
      ('loachapoka-elementary-school', 'Loachapoka Elementary School', '2026-08-25T00:00:00+00:00'),
      ('south-smiths-station-elementary-school', 'South Smiths Station Elementary School', '2026-08-25T00:00:00+00:00'),
      ('east-smiths-station-elementary-school', 'East Smiths Station Elementary School', '2026-08-25T00:00:00+00:00'),
      ('beauregard-high-school', 'Beauregard High School', '2026-08-25T00:00:00+00:00'),
      ('beulah-high-school', 'Beulah High School', '2026-08-25T00:00:00+00:00'),
      ('loachapoka-high-school', 'Loachapoka High School', '2026-08-25T00:00:00+00:00'),
      ('sanford-middle-school', 'Sanford Middle School', '2026-08-25T00:00:00+00:00'),
      ('west-smiths-station-elementary-school', 'West Smiths Station Elementary School', '2026-08-25T00:00:00+00:00'),
      ('smiths-station-high-school', 'Smiths Station High School', '2026-08-25T00:00:00+00:00'),
      ('smiths-station-junior-high-school', 'Smiths Station Junior High School', '2026-08-25T00:00:00+00:00'),
      ('wacoochee-elementary-school', 'Wacoochee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('smith-station-freshman-center', 'Smith Station Freshman Center', '2026-08-25T00:00:00+00:00'),
      ('ardmore-high-school', 'Ardmore High School', '2026-08-25T00:00:00+00:00'),
      ('clements-high-school', 'Clements High School', '2026-08-25T00:00:00+00:00'),
      ('east-limestone-high-school', 'East Limestone High School', '2026-08-25T00:00:00+00:00'),
      ('johnson-elementary-school', 'Johnson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sugar-creek-elementary-school', 'Sugar Creek Elementary School', '2026-08-25T00:00:00+00:00'),
      ('piney-chapel-elementary-school', 'Piney Chapel Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tanner-high-school', 'Tanner High School', '2026-08-25T00:00:00+00:00'),
      ('west-limestone-high-school', 'West Limestone High School', '2026-08-25T00:00:00+00:00'),
      ('limestone-county-area-vocational-technology', 'Limestone County Area Vocational Technology', '2026-08-25T00:00:00+00:00'),
      ('creekside-elementary-school-2', 'Creekside Elementary School', '2026-08-25T00:00:00+00:00'),
      ('elkmont-high-school', 'Elkmont High School', '2026-08-25T00:00:00+00:00'),
      ('cedar-hill-elementary-school', 'Cedar Hill Elementary School', '2026-08-25T00:00:00+00:00'),
      ('blue-springs-elementary-school', 'Blue Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tanner-elementary-school', 'Tanner Elementary School', '2026-08-25T00:00:00+00:00'),
      ('creekside-primary-school', 'Creekside Primary School', '2026-08-25T00:00:00+00:00'),
      ('elkmont-elementary-school', 'Elkmont Elementary School', '2026-08-25T00:00:00+00:00'),
      ('alabama-connections-academy', 'Alabama Connections Academy', '2026-08-25T00:00:00+00:00'),
      ('george-p-austin-junior-high-school', 'George P Austin Junior High School', '2026-08-25T00:00:00+00:00'),
      ('linden-elementary-school', 'Linden Elementary School', '2026-08-25T00:00:00+00:00'),
      ('linden-high-school', 'Linden High School', '2026-08-25T00:00:00+00:00'),
      ('calhoun-high-school', 'Calhoun High School', '2026-08-25T00:00:00+00:00'),
      ('central-elementary-school-3', 'Central Elementary School', '2026-08-25T00:00:00+00:00'),
      ('central-high-school-3', 'Central High School', '2026-08-25T00:00:00+00:00'),
      ('jacksonsteele-elementary-school', 'Jacksonsteele Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lowndes-county-career-technical-center', 'Lowndes County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('project-success-learning-center', 'Project Success Learning Center', '2026-08-25T00:00:00+00:00'),
      ('fort-deposit-elementary-school', 'Fort Deposit Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hayneville-middle-school', 'Hayneville Middle School', '2026-08-25T00:00:00+00:00'),
      ('lowndes-county-middle-school', 'Lowndes County Middle School', '2026-08-25T00:00:00+00:00'),
      ('notasulga-high-school', 'Notasulga High School', '2026-08-25T00:00:00+00:00'),
      ('tuskegee-institute-middle-school', 'Tuskegee Institute Middle School', '2026-08-25T00:00:00+00:00'),
      ('tuskegee-public-elementary', 'Tuskegee Public Elementary', '2026-08-25T00:00:00+00:00'),
      ('dc-wolfe-school', 'Dc Wolfe School', '2026-08-25T00:00:00+00:00'),
      ('booker-t-washington-high', 'Booker T Washington High', '2026-08-25T00:00:00+00:00'),
      ('george-washington-carver-elementary-school', 'George Washington Carver Elementary School', '2026-08-25T00:00:00+00:00'),
      ('macon-county-area-vocational-school', 'Macon County Area Vocational School', '2026-08-25T00:00:00+00:00'),
      ('hazel-green-elementary-school', 'Hazel Green Elementary School', '2026-08-25T00:00:00+00:00'),
      ('madison-county-high-school', 'Madison County High School', '2026-08-25T00:00:00+00:00'),
      ('monrovia-middle-school', 'Monrovia Middle School', '2026-08-25T00:00:00+00:00'),
      ('new-hope-elementary-school', 'New Hope Elementary School', '2026-08-25T00:00:00+00:00'),
      ('harvest-school', 'Harvest School', '2026-08-25T00:00:00+00:00'),
      ('hazel-green-high-school', 'Hazel Green High School', '2026-08-25T00:00:00+00:00'),
      ('madison-county-elementary-school', 'Madison County Elementary School', '2026-08-25T00:00:00+00:00'),
      ('madison-cross-roads-elementary-school', 'Madison Cross Roads Elementary School', '2026-08-25T00:00:00+00:00'),
      ('monrovia-elementary-school', 'Monrovia Elementary School', '2026-08-25T00:00:00+00:00'),
      ('new-hope-high-school', 'New Hope High School', '2026-08-25T00:00:00+00:00'),
      ('new-market-school', 'New Market School', '2026-08-25T00:00:00+00:00'),
      ('owens-cross-roads-school', 'Owens Cross Roads School', '2026-08-25T00:00:00+00:00'),
      ('sparkman-high-school', 'Sparkman High School', '2026-08-25T00:00:00+00:00'),
      ('walnut-grove-school', 'Walnut Grove School', '2026-08-25T00:00:00+00:00'),
      ('madison-county-alternative-school', 'Madison County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('madison-county-career-technical-center', 'Madison County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('meridianville-middle-school', 'Meridianville Middle School', '2026-08-25T00:00:00+00:00'),
      ('sparkman-middle-school', 'Sparkman Middle School', '2026-08-25T00:00:00+00:00'),
      ('endeavor-elementary-school', 'Endeavor Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mt-carmel-elementary-school', 'Mt Carmel Elementary School', '2026-08-25T00:00:00+00:00'),
      ('buckhorn-high-school', 'Buckhorn High School', '2026-08-25T00:00:00+00:00'),
      ('central-school', 'Central School', '2026-08-25T00:00:00+00:00'),
      ('lynn-fanning-elementary-school', 'Lynn Fanning Elementary School', '2026-08-25T00:00:00+00:00'),
      ('legacy-elementary-school', 'Legacy Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sparkman-ninth-grade-school', 'Sparkman Ninth Grade School', '2026-08-25T00:00:00+00:00'),
      ('riverton-elementary-school', 'Riverton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('buckhorn-middle-school', 'Buckhorn Middle School', '2026-08-25T00:00:00+00:00'),
      ('riverton-intermediate-school', 'Riverton Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('moores-mill-intermediate-school', 'Moores Mill Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('madison-county-virtual-academy', 'Madison County Virtual Academy', '2026-08-25T00:00:00+00:00'),
      ('amelia-l-johnson-high-school', 'Amelia L Johnson High School', '2026-08-25T00:00:00+00:00'),
      ('marengo-high-school', 'Marengo High School', '2026-08-25T00:00:00+00:00'),
      ('sweet-water-high-school', 'Sweet Water High School', '2026-08-25T00:00:00+00:00'),
      ('brilliant-school', 'Brilliant School', '2026-08-25T00:00:00+00:00'),
      ('marion-county-high-school', 'Marion County High School', '2026-08-25T00:00:00+00:00'),
      ('guin-elementary-school', 'Guin Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hackleburg-high-school', 'Hackleburg High School', '2026-08-25T00:00:00+00:00'),
      ('hamilton-middle-school', 'Hamilton Middle School', '2026-08-25T00:00:00+00:00'),
      ('hamilton-high-school', 'Hamilton High School', '2026-08-25T00:00:00+00:00'),
      ('phillips-high-school', 'Phillips High School', '2026-08-25T00:00:00+00:00'),
      ('marion-county-alternative-school', 'Marion County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('phillips-elementary-school', 'Phillips Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hamilton-elementary-school', 'Hamilton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hackleburg-elementary-school', 'Hackleburg Elementary School', '2026-08-25T00:00:00+00:00'),
      ('midfield-elementary-school', 'Midfield Elementary School', '2026-08-25T00:00:00+00:00'),
      ('midfield-high-school', 'Midfield High School', '2026-08-25T00:00:00+00:00'),
      ('rutledge-school', 'Rutledge School', '2026-08-25T00:00:00+00:00'),
      ('midfield-area-vocational-department', 'Midfield Area Vocational Department', '2026-08-25T00:00:00+00:00'),
      ('allentown-elementary-school', 'Allentown Elementary School', '2026-08-25T00:00:00+00:00'),
      ('peter-f-alba-middle-school', 'Peter F Alba Middle School', '2026-08-25T00:00:00+00:00'),
      ('mary-b-austin-elementary-school', 'Mary B Austin Elementary School', '2026-08-25T00:00:00+00:00'),
      ('denton-magnet-school-of-technology', 'Denton Magnet School Of Technology', '2026-08-25T00:00:00+00:00'),
      ('ben-c-rain-high-school', 'Ben C Rain High School', '2026-08-25T00:00:00+00:00'),
      ('baker-high-school', 'Baker High School', '2026-08-25T00:00:00+00:00'),
      ('mattie-t-blount-high-school', 'Mattie T Blount High School', '2026-08-25T00:00:00+00:00'),
      ('booker-t-washington-middle-school', 'Booker T Washington Middle School', '2026-08-25T00:00:00+00:00'),
      ('calcedeaver-elementary-school', 'Calcedeaver Elementary School', '2026-08-25T00:00:00+00:00'),
      ('citronelle-high-school', 'Citronelle High School', '2026-08-25T00:00:00+00:00'),
      ('w-h-council-traditional-school', 'W H Council Traditional School', '2026-08-25T00:00:00+00:00'),
      ('nan-gray-davis-elementary-school', 'Nan Gray Davis Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dauphin-island-elementary-school', 'Dauphin Island Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wp-davidson-high-school', 'Wp Davidson High School', '2026-08-25T00:00:00+00:00'),
      ('er-dickson-elementary-school', 'Er Dickson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dixon-elementary-school', 'Dixon Elementary School', '2026-08-25T00:00:00+00:00'),
      ('olive-j-dodge-elementary-school', 'Olive J Dodge Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dunbar-creative-performing-arts', 'Dunbar Creative Performing Arts', '2026-08-25T00:00:00+00:00'),
      ('collinsrhodes-elementary-school', 'Collinsrhodes Elementary School', '2026-08-25T00:00:00+00:00'),
      ('elizabeth-fonde-elementary-school', 'Elizabeth Fonde Elementary School', '2026-08-25T00:00:00+00:00'),
      ('forest-hill-elementary-school', 'Forest Hill Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cora-castlen-elementary', 'Cora Castlen Elementary', '2026-08-25T00:00:00+00:00'),
      ('hollingers-island-elementary-school', 'Hollingers Island Elementary School', '2026-08-25T00:00:00+00:00'),
      ('indian-springs-elementary-school', 'Indian Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('john-will-elementary-school', 'John Will Elementary School', '2026-08-25T00:00:00+00:00'),
      ('clarkshaw-magnet-school', 'Clarkshaw Magnet School', '2026-08-25T00:00:00+00:00'),
      ('leinkauf-elementary-school', 'Leinkauf Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mary-g-montgomery-high-school', 'Mary G Montgomery High School', '2026-08-25T00:00:00+00:00'),
      ('mary-w-burroughs-elementary-school', 'Mary W Burroughs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('maryvale-elementary-school', 'Maryvale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('grand-bay-middle-school', 'Grand Bay Middle School', '2026-08-25T00:00:00+00:00'),
      ('mobile-county-training-middle-school', 'Mobile County Training Middle School', '2026-08-25T00:00:00+00:00'),
      ('morningside-elementary-school', 'Morningside Elementary School', '2026-08-25T00:00:00+00:00'),
      ('murphy-high-school', 'Murphy High School', '2026-08-25T00:00:00+00:00'),
      ('old-shell-road-magnet-school', 'Old Shell Road Magnet School', '2026-08-25T00:00:00+00:00'),
      ('orchard-elementary-school', 'Orchard Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pillans-middle-school', 'Pillans Middle School', '2026-08-25T00:00:00+00:00'),
      ('phillips-preparatory-middle-school', 'Phillips Preparatory Middle School', '2026-08-25T00:00:00+00:00'),
      ('wd-robbins-elementary-school', 'Wd Robbins Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cl-scarborough-model-middle-school', 'Cl Scarborough Model Middle School', '2026-08-25T00:00:00+00:00'),
      ('semmes-middle-school', 'Semmes Middle School', '2026-08-25T00:00:00+00:00'),
      ('kate-shepard-elementary-school', 'Kate Shepard Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tanner-williams-elementary-school', 'Tanner Williams Elementary School', '2026-08-25T00:00:00+00:00'),
      ('katherine-h-hankins-middle-school', 'Katherine H Hankins Middle School', '2026-08-25T00:00:00+00:00'),
      ('john-l-leflore-magnet-school', 'John L Leflore Magnet School', '2026-08-25T00:00:00+00:00'),
      ('chastangfournier-middle-school', 'Chastangfournier Middle School', '2026-08-25T00:00:00+00:00'),
      ('cf-vigor-high-school', 'Cf Vigor High School', '2026-08-25T00:00:00+00:00'),
      ('wc-griggs-elementary-school', 'Wc Griggs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('spencerwestlawn-elementary-school', 'Spencerwestlawn Elementary School', '2026-08-25T00:00:00+00:00'),
      ('whitley-elementary-school', 'Whitley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lillie-b-williamson-high-school', 'Lillie B Williamson High School', '2026-08-25T00:00:00+00:00'),
      ('wilmer-elementary-school', 'Wilmer Elementary School', '2026-08-25T00:00:00+00:00'),
      ('alma-bryant-high-school', 'Alma Bryant High School', '2026-08-25T00:00:00+00:00'),
      ('burns-middle-school', 'Burns Middle School', '2026-08-25T00:00:00+00:00'),
      ('calloway-smith-middle-school', 'Calloway Smith Middle School', '2026-08-25T00:00:00+00:00'),
      ('grant-elementary-school', 'Grant Elementary School', '2026-08-25T00:00:00+00:00'),
      ('florence-howard-elementary-school', 'Florence Howard Elementary School', '2026-08-25T00:00:00+00:00'),
      ('the-pathway', 'The Pathway', '2026-08-25T00:00:00+00:00'),
      ('tl-faulkner-school', 'Tl Faulkner  School', '2026-08-25T00:00:00+00:00'),
      ('george-h-bryant-vocationalagricultural-center', 'George H Bryant Vocationalagricultural Center', '2026-08-25T00:00:00+00:00'),
      ('hutchens-elementary-school', 'Hutchens Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bernice-j-causey-middle-school', 'Bernice J Causey Middle School', '2026-08-25T00:00:00+00:00'),
      ('elsie-collier-elementary-school', 'Elsie Collier Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mcdavidjones-elementary-school', 'Mcdavidjones Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lott-middle-school', 'Lott Middle School', '2026-08-25T00:00:00+00:00'),
      ('j-e-turner-elementary', 'J E Turner Elementary', '2026-08-25T00:00:00+00:00'),
      ('george-hall-elementary-school', 'George Hall Elementary School', '2026-08-25T00:00:00+00:00'),
      ('anna-f-booth-elementary-school', 'Anna F Booth Elementary School', '2026-08-25T00:00:00+00:00'),
      ('semmes-elementary-school', 'Semmes Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dr-robert-w-gilliard-elementary', 'Dr Robert W Gilliard Elementary', '2026-08-25T00:00:00+00:00'),
      ('goodwill-easter-seal-center-special-child', 'Goodwill Easter Seal Center Special Child', '2026-08-25T00:00:00+00:00'),
      ('mobile-mental-health-center', 'Mobile Mental Health Center', '2026-08-25T00:00:00+00:00'),
      ('holloway-elementary', 'Holloway Elementary', '2026-08-25T00:00:00+00:00'),
      ('augusta-evans-school', 'Augusta Evans School', '2026-08-25T00:00:00+00:00'),
      ('meadowlake-elementary', 'Meadowlake Elementary', '2026-08-25T00:00:00+00:00'),
      ('pearl-haskew-elementary', 'Pearl Haskew Elementary', '2026-08-25T00:00:00+00:00'),
      ('ucp-of-mobile-inc', 'Ucp Of Mobile Inc', '2026-08-25T00:00:00+00:00'),
      ('continuous-learning-center', 'Continuous Learning Center', '2026-08-25T00:00:00+00:00'),
      ('theodore-high-school', 'Theodore High School', '2026-08-25T00:00:00+00:00'),
      ('hl-sonny-callahan-school-for-the-deaf-and-blind', 'Hl Sonny Callahan School For The Deaf And Blind', '2026-08-25T00:00:00+00:00'),
      ('saint-elmo-elementary-school', 'Saint Elmo Elementary School', '2026-08-25T00:00:00+00:00'),
      ('erwin-craighead-elementary-school', 'Erwin Craighead Elementary School', '2026-08-25T00:00:00+00:00'),
      ('just-4-development-laboratory', 'Just 4 Development Laboratory', '2026-08-25T00:00:00+00:00'),
      ('orourke-elementary-school', 'Orourke Elementary School', '2026-08-25T00:00:00+00:00'),
      ('breitling-elementary-school', 'Breitling Elementary School', '2026-08-25T00:00:00+00:00'),
      ('north-mobile-county-middle-school', 'North Mobile County Middle School', '2026-08-25T00:00:00+00:00'),
      ('dawes-intermediate-school', 'Dawes Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('evening-educational-options', 'Evening Educational Options', '2026-08-25T00:00:00+00:00'),
      ('taylor-white-elementary-school', 'Taylor White Elementary School', '2026-08-25T00:00:00+00:00'),
      ('eicholdmertz-school-of-math-and-science', 'Eicholdmertz School Of Math And Science', '2026-08-25T00:00:00+00:00'),
      ('citronelle-center-for-advanced-technology', 'Citronelle Center For Advanced Technology', '2026-08-25T00:00:00+00:00'),
      ('barton-academy-for-advanced-world-studies', 'Barton Academy For Advanced World Studies', '2026-08-25T00:00:00+00:00'),
      ('monroe-county-high-school', 'Monroe County High School', '2026-08-25T00:00:00+00:00'),
      ('excel-high-school', 'Excel High School', '2026-08-25T00:00:00+00:00'),
      ('j-f-shields-high-school', 'J F Shields High School', '2026-08-25T00:00:00+00:00'),
      ('j-u-blacksher-school', 'J U Blacksher School', '2026-08-25T00:00:00+00:00'),
      ('monroe-intermediate-school', 'Monroe Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('monroeville-middle-school', 'Monroeville Middle School', '2026-08-25T00:00:00+00:00'),
      ('c-p-carmichael-alternative-school', 'C P Carmichael Alternative School', '2026-08-25T00:00:00+00:00'),
      ('monroe-county-careertechnical-center', 'Monroe County Careertechnical Center', '2026-08-25T00:00:00+00:00'),
      ('monroeville-elementary-school', 'Monroeville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('booker-t-washington-magnet-high-school', 'Booker T Washington Magnet High School', '2026-08-25T00:00:00+00:00'),
      ('bear-exploration-center', 'Bear Exploration Center', '2026-08-25T00:00:00+00:00'),
      ('bellingrath-middle-school', 'Bellingrath Middle School', '2026-08-25T00:00:00+00:00'),
      ('capitol-heights-middle-school', 'Capitol Heights Middle School', '2026-08-25T00:00:00+00:00'),
      ('carver-elementary-school', 'Carver Elementary School', '2026-08-25T00:00:00+00:00'),
      ('catoma-elementary-school', 'Catoma Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chisholm-elementary-school', 'Chisholm Elementary School', '2026-08-25T00:00:00+00:00'),
      ('crump-elementary-school', 'Crump Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dalraida-elementary-school', 'Dalraida Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dannelly-elementary-school', 'Dannelly Elementary School', '2026-08-25T00:00:00+00:00'),
      ('davis-elementary-school', 'Davis Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dozier-elementary-school', 'Dozier Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dunbarramer-school', 'Dunbarramer School', '2026-08-25T00:00:00+00:00'),
      ('mcintyre-comprehensive-academy', 'Mcintyre Comprehensive Academy', '2026-08-25T00:00:00+00:00'),
      ('flowers-elementary-school', 'Flowers Elementary School', '2026-08-25T00:00:00+00:00'),
      ('floyd-middle-school', 'Floyd Middle School', '2026-08-25T00:00:00+00:00'),
      ('forest-avenue-elementary-school', 'Forest Avenue Elementary School', '2026-08-25T00:00:00+00:00'),
      ('carver-senior-high-school', 'Carver Senior High School', '2026-08-25T00:00:00+00:00'),
      ('goodwyn-middle-school', 'Goodwyn Middle School', '2026-08-25T00:00:00+00:00'),
      ('highland-avenue-elementary-school', 'Highland Avenue Elementary School', '2026-08-25T00:00:00+00:00'),
      ('highland-gardens-elementary-school', 'Highland Gardens Elementary School', '2026-08-25T00:00:00+00:00'),
      ('jefferson-davis-high-school', 'Jefferson Davis High School', '2026-08-25T00:00:00+00:00'),
      ('johnson-elementary-school-2', 'Johnson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('macmillan-international-at-mckee', 'Macmillan International At Mckee', '2026-08-25T00:00:00+00:00'),
      ('morningview-elementary-school', 'Morningview Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pintlala-elementary-school', 'Pintlala Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lee-high-school-2', 'Lee High School', '2026-08-25T00:00:00+00:00'),
      ('lanier-senior-high-school', 'Lanier Senior High School', '2026-08-25T00:00:00+00:00'),
      ('southlawn-elementary-school', 'Southlawn Elementary School', '2026-08-25T00:00:00+00:00'),
      ('vaughn-road-elementary-school', 'Vaughn Road Elementary School', '2026-08-25T00:00:00+00:00'),
      ('king-elementary', 'King Elementary', '2026-08-25T00:00:00+00:00'),
      ('morris-elementary-school-2', 'Morris Elementary School', '2026-08-25T00:00:00+00:00'),
      ('southlawn-middle-school', 'Southlawn Middle School', '2026-08-25T00:00:00+00:00'),
      ('brewbaker-intermediate-school', 'Brewbaker Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('loveless-academic-magnet-program-high-school', 'Loveless Academic Magnet Program High School', '2026-08-25T00:00:00+00:00'),
      ('nixon-elementary-school', 'Nixon Elementary School', '2026-08-25T00:00:00+00:00'),
      ('brewbaker-technology-magnet-high-school', 'Brewbaker Technology Magnet High School', '2026-08-25T00:00:00+00:00'),
      ('garrett-elementary-school', 'Garrett Elementary School', '2026-08-25T00:00:00+00:00'),
      ('halcyon-elementary-school', 'Halcyon Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mckee-middle-school', 'Mckee Middle School', '2026-08-25T00:00:00+00:00'),
      ('brewbaker-middle-school', 'Brewbaker Middle School', '2026-08-25T00:00:00+00:00'),
      ('wares-ferry-elementary-school', 'Wares Ferry Elementary School', '2026-08-25T00:00:00+00:00'),
      ('childrens-center', 'Childrens Center', '2026-08-25T00:00:00+00:00'),
      ('brewbaker-primary-school', 'Brewbaker Primary School', '2026-08-25T00:00:00+00:00'),
      ('baldwin-art-and-academics-magnet', 'Baldwin Art And Academics Magnet', '2026-08-25T00:00:00+00:00'),
      ('fitzpatrick-elementary-school', 'Fitzpatrick Elementary School', '2026-08-25T00:00:00+00:00'),
      ('blount-elementary-school', 'Blount Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wilson-elementary-school-2', 'Wilson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('carr-middle-school', 'Carr Middle School', '2026-08-25T00:00:00+00:00'),
      ('mckee-prek-center', 'Mckee Prek Center', '2026-08-25T00:00:00+00:00'),
      ('park-crossing-high-school', 'Park Crossing High School', '2026-08-25T00:00:00+00:00'),
      ('montgomery-preparatory-academy-for-career-technologies', 'Montgomery Preparatory Academy For Career Technologies', '2026-08-25T00:00:00+00:00'),
      ('danvilleneel-elementary-school', 'Danvilleneel Elementary School', '2026-08-25T00:00:00+00:00'),
      ('falkville-elementary-school', 'Falkville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('west-morgan-elementary-school', 'West Morgan Elementary School', '2026-08-25T00:00:00+00:00'),
      ('danville-middle-school', 'Danville Middle School', '2026-08-25T00:00:00+00:00'),
      ('cotaco-school', 'Cotaco School', '2026-08-25T00:00:00+00:00'),
      ('danville-high-school', 'Danville High School', '2026-08-25T00:00:00+00:00'),
      ('eva-school', 'Eva School', '2026-08-25T00:00:00+00:00'),
      ('falkville-high-school', 'Falkville High School', '2026-08-25T00:00:00+00:00'),
      ('laceys-spring-elementary-school', 'Laceys Spring Elementary School', '2026-08-25T00:00:00+00:00'),
      ('priceville-high-school', 'Priceville High School', '2026-08-25T00:00:00+00:00'),
      ('sparkman-elementary-school', 'Sparkman Elementary School', '2026-08-25T00:00:00+00:00'),
      ('union-hill-school', 'Union Hill School', '2026-08-25T00:00:00+00:00'),
      ('west-morgan-high-school', 'West Morgan High School', '2026-08-25T00:00:00+00:00'),
      ('morgan-county-schools-technology-park', 'Morgan County Schools Technology Park', '2026-08-25T00:00:00+00:00'),
      ('priceville-elementary-school', 'Priceville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('morgan-county-learning-center', 'Morgan County Learning Center', '2026-08-25T00:00:00+00:00'),
      ('albert-p-brewer-high-school', 'Albert P Brewer High School', '2026-08-25T00:00:00+00:00'),
      ('west-morgan-middle-school', 'West Morgan Middle School', '2026-08-25T00:00:00+00:00'),
      ('priceville-junior-high-school', 'Priceville Junior High School', '2026-08-25T00:00:00+00:00'),
      ('brookwood-forest-elementary-school', 'Brookwood Forest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cherokee-bend-elementary-school', 'Cherokee Bend Elementary School', '2026-08-25T00:00:00+00:00'),
      ('crestline-elementary-school-2', 'Crestline Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mountain-brook-high-school', 'Mountain Brook High School', '2026-08-25T00:00:00+00:00'),
      ('mountain-brook-junior-high-school', 'Mountain Brook Junior High School', '2026-08-25T00:00:00+00:00'),
      ('mountain-brook-elementary-school', 'Mountain Brook Elementary School', '2026-08-25T00:00:00+00:00'),
      ('muscle-shoals-middle-school', 'Muscle Shoals Middle School', '2026-08-25T00:00:00+00:00'),
      ('highland-park-elementary-school', 'Highland Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('muscle-shoals-high-school', 'Muscle Shoals High School', '2026-08-25T00:00:00+00:00'),
      ('webster-elementary-school', 'Webster Elementary School', '2026-08-25T00:00:00+00:00'),
      ('muscle-shoals-career-academy', 'Muscle Shoals Career Academy', '2026-08-25T00:00:00+00:00'),
      ('mcbride-elementary-school', 'Mcbride Elementary School', '2026-08-25T00:00:00+00:00'),
      ('howell-graves-preschool', 'Howell Graves Preschool', '2026-08-25T00:00:00+00:00'),
      ('oneonta-elementary-school', 'Oneonta Elementary School', '2026-08-25T00:00:00+00:00'),
      ('oneonta-high-school', 'Oneonta High School', '2026-08-25T00:00:00+00:00'),
      ('oneonta-middle-school', 'Oneonta Middle School', '2026-08-25T00:00:00+00:00'),
      ('west-forest-intermediate-school', 'West Forest Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('northside-school', 'Northside School', '2026-08-25T00:00:00+00:00'),
      ('carver-primary-school', 'Carver Primary School', '2026-08-25T00:00:00+00:00'),
      ('jeter-primary-school', 'Jeter Primary School', '2026-08-25T00:00:00+00:00'),
      ('opelika-high-school', 'Opelika High School', '2026-08-25T00:00:00+00:00'),
      ('opelika-middle-school', 'Opelika Middle School', '2026-08-25T00:00:00+00:00'),
      ('morris-avenue-intermediate-school', 'Morris Avenue Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('southview-primary-school', 'Southview Primary School', '2026-08-25T00:00:00+00:00'),
      ('opelika-learning-center', 'Opelika Learning Center', '2026-08-25T00:00:00+00:00'),
      ('fox-run-school', 'Fox Run School', '2026-08-25T00:00:00+00:00'),
      ('opp-high-school', 'Opp High School', '2026-08-25T00:00:00+00:00'),
      ('opp-middle-school', 'Opp Middle School', '2026-08-25T00:00:00+00:00'),
      ('opp-elementary-school', 'Opp Elementary School', '2026-08-25T00:00:00+00:00'),
      ('oxford-high-school', 'Oxford High School', '2026-08-25T00:00:00+00:00'),
      ('oxford-elementary-school', 'Oxford Elementary School', '2026-08-25T00:00:00+00:00'),
      ('oxford-middle-school', 'Oxford Middle School', '2026-08-25T00:00:00+00:00'),
      ('oxford-area-vocational-school', 'Oxford Area Vocational School', '2026-08-25T00:00:00+00:00'),
      ('ce-hanna-school', 'Ce Hanna School', '2026-08-25T00:00:00+00:00'),
      ('de-armanville-elementary-school', 'De Armanville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('coldwater-elementary-school', 'Coldwater Elementary School', '2026-08-25T00:00:00+00:00'),
      ('carroll-high-school', 'Carroll High School', '2026-08-25T00:00:00+00:00'),
      ('d-a-smith-middle-school', 'D A Smith Middle School', '2026-08-25T00:00:00+00:00'),
      ('harry-n-mixon-intermediate-school', 'Harry N Mixon Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('joseph-w-lisenby-primary-school', 'Joseph W Lisenby Primary School', '2026-08-25T00:00:00+00:00'),
      ('eagle-academy', 'Eagle Academy', '2026-08-25T00:00:00+00:00'),
      ('carroll-high-school-career-center', 'Carroll High School Career Center', '2026-08-25T00:00:00+00:00'),
      ('eden-elementary-school', 'Eden Elementary School', '2026-08-25T00:00:00+00:00'),
      ('duran-south', 'Duran South', '2026-08-25T00:00:00+00:00'),
      ('coosa-valley-elementary-school', 'Coosa Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('duran-junior-high-school', 'Duran Junior High School', '2026-08-25T00:00:00+00:00'),
      ('iola-roberts-elementary-school', 'Iola Roberts Elementary School', '2026-08-25T00:00:00+00:00'),
      ('pell-city-high-school', 'Pell City High School', '2026-08-25T00:00:00+00:00'),
      ('walter-m-kennedy-school', 'Walter M Kennedy School', '2026-08-25T00:00:00+00:00'),
      ('williams-intermediate-school', 'Williams Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('robert-c-hatch-high-school', 'Robert C Hatch High School', '2026-08-25T00:00:00+00:00'),
      ('francis-marion-school', 'Francis Marion School', '2026-08-25T00:00:00+00:00'),
      ('central-high-school-4', 'Central High School', '2026-08-25T00:00:00+00:00'),
      ('meadowlane-elementary-school', 'Meadowlane Elementary School', '2026-08-25T00:00:00+00:00'),
      ('phenix-city-intermediate-school', 'Phenix City Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('ridgecrest-elementary-school-2', 'Ridgecrest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('south-girard-school', 'South Girard School', '2026-08-25T00:00:00+00:00'),
      ('sherwood-elementary-school', 'Sherwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('westview-elementary-school', 'Westview Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lakewood-elementary-school-2', 'Lakewood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('phenix-city-elementary-school', 'Phenix City Elementary School', '2026-08-25T00:00:00+00:00'),
      ('central-freshman-academy', 'Central Freshman Academy', '2026-08-25T00:00:00+00:00'),
      ('lakewood-primary-school', 'Lakewood Primary School', '2026-08-25T00:00:00+00:00'),
      ('success-academy', 'Success Academy', '2026-08-25T00:00:00+00:00'),
      ('aliceville-elementary-school', 'Aliceville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('aliceville-high-school', 'Aliceville High School', '2026-08-25T00:00:00+00:00'),
      ('pickens-county-high-school', 'Pickens County High School', '2026-08-25T00:00:00+00:00'),
      ('gordo-elementary-school', 'Gordo Elementary School', '2026-08-25T00:00:00+00:00'),
      ('gordo-high-school', 'Gordo High School', '2026-08-25T00:00:00+00:00'),
      ('reform-elementary-school', 'Reform Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ladow-technical-center', 'Ladow Technical Center', '2026-08-25T00:00:00+00:00'),
      ('piedmont-high-school', 'Piedmont High School', '2026-08-25T00:00:00+00:00'),
      ('piedmont-elementary-school', 'Piedmont Elementary School', '2026-08-25T00:00:00+00:00'),
      ('piedmont-middle-school', 'Piedmont Middle School', '2026-08-25T00:00:00+00:00'),
      ('banks-school', 'Banks School', '2026-08-25T00:00:00+00:00'),
      ('pike-county-high-school', 'Pike County High School', '2026-08-25T00:00:00+00:00'),
      ('goshen-elementary-school', 'Goshen Elementary School', '2026-08-25T00:00:00+00:00'),
      ('goshen-high-school', 'Goshen High School', '2026-08-25T00:00:00+00:00'),
      ('pike-county-elementary-school', 'Pike County Elementary School', '2026-08-25T00:00:00+00:00'),
      ('troypike-center-for-technology', 'Troypike Center For Technology', '2026-08-25T00:00:00+00:00'),
      ('pike-county-alternative-learning-center', 'Pike County Alternative Learning Center', '2026-08-25T00:00:00+00:00'),
      ('randolph-county-high-school', 'Randolph County High School', '2026-08-25T00:00:00+00:00'),
      ('rock-mills-junior-high-school', 'Rock Mills Junior High School', '2026-08-25T00:00:00+00:00'),
      ('wadley-high-school', 'Wadley High School', '2026-08-25T00:00:00+00:00'),
      ('wedowee-middle-school', 'Wedowee Middle School', '2026-08-25T00:00:00+00:00'),
      ('woodland-high-school', 'Woodland High School', '2026-08-25T00:00:00+00:00'),
      ('randolphroanoke-career-technology-center', 'Randolphroanoke Career Technology Center', '2026-08-25T00:00:00+00:00'),
      ('wedowee-elementary-school', 'Wedowee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('woodland-elementary-school', 'Woodland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('handley-high-school', 'Handley High School', '2026-08-25T00:00:00+00:00'),
      ('handley-middle-school', 'Handley Middle School', '2026-08-25T00:00:00+00:00'),
      ('knight-enloe-elementary-school', 'Knight Enloe Elementary School', '2026-08-25T00:00:00+00:00'),
      ('randolphroanoke-career-technology-center-2', 'Randolphroanoke Career Technology Center', '2026-08-25T00:00:00+00:00'),
      ('dixie-elementary-school', 'Dixie Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ladonia-elementary-school', 'Ladonia Elementary School', '2026-08-25T00:00:00+00:00'),
      ('mount-olive-intermediate-school', 'Mount Olive Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('oliver-elementary-school', 'Oliver Elementary School', '2026-08-25T00:00:00+00:00'),
      ('alternative-learning-center', 'Alternative Learning Center', '2026-08-25T00:00:00+00:00'),
      ('russell-county-middle-school', 'Russell County Middle School', '2026-08-25T00:00:00+00:00'),
      ('russell-county-high-school', 'Russell County High School', '2026-08-25T00:00:00+00:00'),
      ('mt-olive-primary-school', 'Mt Olive Primary School', '2026-08-25T00:00:00+00:00'),
      ('russellville-elementary-school', 'Russellville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('russellville-middle-school', 'Russellville Middle School', '2026-08-25T00:00:00+00:00'),
      ('russellville-high-school', 'Russellville High School', '2026-08-25T00:00:00+00:00'),
      ('west-elementary-school-2', 'West Elementary School', '2026-08-25T00:00:00+00:00'),
      ('russellville-city-career-tech-center', 'Russellville City Career Tech Center', '2026-08-25T00:00:00+00:00'),
      ('caldwell-elementary-school', 'Caldwell Elementary School', '2026-08-25T00:00:00+00:00'),
      ('scottsboro-high-school', 'Scottsboro High School', '2026-08-25T00:00:00+00:00'),
      ('scottsboro-junior-high-school', 'Scottsboro Junior High School', '2026-08-25T00:00:00+00:00'),
      ('collins-intermediate-school', 'Collins Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('thurston-t-nelson-elementary-school', 'Thurston T Nelson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sophia-p-kingston-elementary-school', 'Sophia P Kingston Elementary School', '2026-08-25T00:00:00+00:00'),
      ('phoenix-school', 'Phoenix School', '2026-08-25T00:00:00+00:00'),
      ('byrd-first-class-early-learning-center', 'Byrd First Class Early Learning Center', '2026-08-25T00:00:00+00:00'),
      ('clark-elementary-school', 'Clark Elementary School', '2026-08-25T00:00:00+00:00'),
      ('school-of-discovery-genesis-center', 'School Of Discovery Genesis Center', '2026-08-25T00:00:00+00:00'),
      ('edgewood-elementary-school-2', 'Edgewood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('meadowview-elementary-school', 'Meadowview Elementary School', '2026-08-25T00:00:00+00:00'),
      ('payne-elementary-school', 'Payne Elementary School', '2026-08-25T00:00:00+00:00'),
      ('selma-high-school', 'Selma High School', '2026-08-25T00:00:00+00:00'),
      ('the-rbhudson-steam-academy', 'The Rbhudson Steam Academy', '2026-08-25T00:00:00+00:00'),
      ('saints-virtual-academy', 'Saints Virtual Academy', '2026-08-25T00:00:00+00:00'),
      ('sheffield-junior-high-school', 'Sheffield Junior High School', '2026-08-25T00:00:00+00:00'),
      ('sheffield-high-school', 'Sheffield High School', '2026-08-25T00:00:00+00:00'),
      ('wa-threadgill-primary-school', 'Wa Threadgill Primary School', '2026-08-25T00:00:00+00:00'),
      ('l-e-willson-elementary-school', 'L E Willson Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chelsea-middle-school', 'Chelsea Middle School', '2026-08-25T00:00:00+00:00'),
      ('oak-mountain-middle-school', 'Oak Mountain Middle School', '2026-08-25T00:00:00+00:00'),
      ('oak-mountain-intermediate-school', 'Oak Mountain Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('calera-elementary', 'Calera Elementary', '2026-08-25T00:00:00+00:00'),
      ('calera-high', 'Calera High', '2026-08-25T00:00:00+00:00'),
      ('chelsea-high-school', 'Chelsea High School', '2026-08-25T00:00:00+00:00'),
      ('columbiana-middle-school', 'Columbiana Middle School', '2026-08-25T00:00:00+00:00'),
      ('shelby-county-high-school', 'Shelby County High School', '2026-08-25T00:00:00+00:00'),
      ('helena-elementary-school', 'Helena Elementary School', '2026-08-25T00:00:00+00:00'),
      ('montevallo-elementary-school', 'Montevallo Elementary School', '2026-08-25T00:00:00+00:00'),
      ('montevallo-high-school', 'Montevallo High School', '2026-08-25T00:00:00+00:00'),
      ('montevallo-middle-school', 'Montevallo Middle School', '2026-08-25T00:00:00+00:00'),
      ('shelby-elementary-school', 'Shelby Elementary School', '2026-08-25T00:00:00+00:00'),
      ('vincent-elementary-school', 'Vincent Elementary School', '2026-08-25T00:00:00+00:00'),
      ('vincent-middle-high-school', 'Vincent Middle High School', '2026-08-25T00:00:00+00:00'),
      ('wilsonville-elementary-school', 'Wilsonville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('oak-mountain-high-school', 'Oak Mountain High School', '2026-08-25T00:00:00+00:00'),
      ('career-technical-education-center', 'Career Technical Education Center', '2026-08-25T00:00:00+00:00'),
      ('new-direction', 'New Direction', '2026-08-25T00:00:00+00:00'),
      ('helena-intermediate-school', 'Helena Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('elvin-hill-elementary-school', 'Elvin Hill Elementary School', '2026-08-25T00:00:00+00:00'),
      ('inverness-elementary-school', 'Inverness Elementary School', '2026-08-25T00:00:00+00:00'),
      ('linda-nolen-learning-center', 'Linda Nolen Learning Center', '2026-08-25T00:00:00+00:00'),
      ('oak-mountain-elementary-school', 'Oak Mountain Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chelsea-park-elementary-school', 'Chelsea Park Elementary School', '2026-08-25T00:00:00+00:00'),
      ('calera-middle', 'Calera Middle', '2026-08-25T00:00:00+00:00'),
      ('mt-laurel-elementary-school', 'Mt Laurel Elementary School', '2026-08-25T00:00:00+00:00'),
      ('helena-middle', 'Helena Middle', '2026-08-25T00:00:00+00:00'),
      ('forest-oaks-elementary-school', 'Forest Oaks Elementary School', '2026-08-25T00:00:00+00:00'),
      ('helena-high-school', 'Helena High School', '2026-08-25T00:00:00+00:00'),
      ('calera-intermediate-school', 'Calera Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('springville-elementary-school', 'Springville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('odenville-elementary-school', 'Odenville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('ashville-middle-school', 'Ashville Middle School', '2026-08-25T00:00:00+00:00'),
      ('springville-middle-school', 'Springville Middle School', '2026-08-25T00:00:00+00:00'),
      ('odenville-middle-school', 'Odenville Middle School', '2026-08-25T00:00:00+00:00'),
      ('eden-area-technical-center', 'Eden Area Technical Center', '2026-08-25T00:00:00+00:00'),
      ('ashville-high-school', 'Ashville High School', '2026-08-25T00:00:00+00:00'),
      ('saint-clair-county-high-school', 'Saint Clair County High School', '2026-08-25T00:00:00+00:00'),
      ('moody-middle-school', 'Moody Middle School', '2026-08-25T00:00:00+00:00'),
      ('ragland-high-school', 'Ragland High School', '2026-08-25T00:00:00+00:00'),
      ('springville-high-school', 'Springville High School', '2026-08-25T00:00:00+00:00'),
      ('steele-elementary-school', 'Steele Elementary School', '2026-08-25T00:00:00+00:00'),
      ('moody-junior-high-school', 'Moody Junior High School', '2026-08-25T00:00:00+00:00'),
      ('ruben-yancy-alternative-school', 'Ruben Yancy Alternative School', '2026-08-25T00:00:00+00:00'),
      ('moody-high-school', 'Moody High School', '2026-08-25T00:00:00+00:00'),
      ('ashville-elementary-school', 'Ashville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('moody-elementary-school', 'Moody Elementary School', '2026-08-25T00:00:00+00:00'),
      ('odenville-intermediate-school', 'Odenville Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('margaret-elementary', 'Margaret Elementary', '2026-08-25T00:00:00+00:00'),
      ('scc-virtual-preparatory-academy', 'Scc Virtual Preparatory Academy', '2026-08-25T00:00:00+00:00'),
      ('livingston-junior-high-school', 'Livingston Junior High School', '2026-08-25T00:00:00+00:00'),
      ('bellbrown-career-technical-center', 'Bellbrown Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('york-west-end-junior-high-school', 'York West End Junior High School', '2026-08-25T00:00:00+00:00'),
      ('kinterbish-junior-high-school', 'Kinterbish Junior High School', '2026-08-25T00:00:00+00:00'),
      ('sumter-central-high-school', 'Sumter Central High School', '2026-08-25T00:00:00+00:00'),
      ('pinecrest-elementary-school', 'Pinecrest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sylacauga-high-school', 'Sylacauga High School', '2026-08-25T00:00:00+00:00'),
      ('indian-valley-elementary-school', 'Indian Valley Elementary School', '2026-08-25T00:00:00+00:00'),
      ('nicholslawson-middle-school', 'Nicholslawson Middle School', '2026-08-25T00:00:00+00:00'),
      ('c-l-salter-elementary-school', 'C L Salter Elementary School', '2026-08-25T00:00:00+00:00'),
      ('graham-elementary-school', 'Graham Elementary School', '2026-08-25T00:00:00+00:00'),
      ('raymond-l-young-elementary-school', 'Raymond L Young Elementary School', '2026-08-25T00:00:00+00:00'),
      ('talladega-high-school', 'Talladega High School', '2026-08-25T00:00:00+00:00'),
      ('zora-ellis-junior-high-school', 'Zora Ellis Junior High School', '2026-08-25T00:00:00+00:00'),
      ('talladega-career-technical-center', 'Talladega Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('evelyn-d-houston-elementary-school', 'Evelyn D Houston Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bb-comer-memorial-elementary-school', 'Bb Comer Memorial Elementary School', '2026-08-25T00:00:00+00:00'),
      ('talladega-county-genesis-school', 'Talladega County Genesis School', '2026-08-25T00:00:00+00:00'),
      ('ah-watwood-elementary-school', 'Ah Watwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('bb-comer-memorial-high-school', 'Bb Comer Memorial High School', '2026-08-25T00:00:00+00:00'),
      ('charles-r-drew-middle-school', 'Charles R Drew Middle School', '2026-08-25T00:00:00+00:00'),
      ('childersburg-elementary-school', 'Childersburg Elementary School', '2026-08-25T00:00:00+00:00'),
      ('childersburg-high-school', 'Childersburg High School', '2026-08-25T00:00:00+00:00'),
      ('lincoln-high-school', 'Lincoln High School', '2026-08-25T00:00:00+00:00'),
      ('talladega-county-central-high', 'Talladega County Central High', '2026-08-25T00:00:00+00:00'),
      ('fayetteville-high-school', 'Fayetteville High School', '2026-08-25T00:00:00+00:00'),
      ('munford-high-school', 'Munford High School', '2026-08-25T00:00:00+00:00'),
      ('winterboro-high-school', 'Winterboro High School', '2026-08-25T00:00:00+00:00'),
      ('munford-elementary-school', 'Munford Elementary School', '2026-08-25T00:00:00+00:00'),
      ('sycamore-school', 'Sycamore School', '2026-08-25T00:00:00+00:00'),
      ('childersburg-middle-school', 'Childersburg Middle School', '2026-08-25T00:00:00+00:00'),
      ('lincoln-elementary-school', 'Lincoln Elementary School', '2026-08-25T00:00:00+00:00'),
      ('stemley-road-elementary-school', 'Stemley Road Elementary School', '2026-08-25T00:00:00+00:00'),
      ('munford-middle-school', 'Munford Middle School', '2026-08-25T00:00:00+00:00'),
      ('horseshoe-bend-high-school', 'Horseshoe Bend High School', '2026-08-25T00:00:00+00:00'),
      ('dadeville-elementary-school', 'Dadeville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('dadeville-high-school', 'Dadeville High School', '2026-08-25T00:00:00+00:00'),
      ('reeltown-high-school', 'Reeltown High School', '2026-08-25T00:00:00+00:00'),
      ('edward-bell-career-technical-center', 'Edward Bell Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('reeltown-elementary-school', 'Reeltown Elementary School', '2026-08-25T00:00:00+00:00'),
      ('southside-middle-school', 'Southside Middle School', '2026-08-25T00:00:00+00:00'),
      ('tallassee-high-school', 'Tallassee High School', '2026-08-25T00:00:00+00:00'),
      ('tallassee-elementary-school', 'Tallassee Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tarrant-elementary-school', 'Tarrant Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tarrant-high-school', 'Tarrant High School', '2026-08-25T00:00:00+00:00'),
      ('tarrant-intermediate-school', 'Tarrant Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('thomasville-elementary-school', 'Thomasville Elementary School', '2026-08-25T00:00:00+00:00'),
      ('thomasville-high-school', 'Thomasville High School', '2026-08-25T00:00:00+00:00'),
      ('thomasville-middle-school', 'Thomasville Middle School', '2026-08-25T00:00:00+00:00'),
      ('alternative-learning-center-2', 'Alternative Learning Center', '2026-08-25T00:00:00+00:00'),
      ('charles-henderson-high-school', 'Charles Henderson High School', '2026-08-25T00:00:00+00:00'),
      ('charles-henderson-middle', 'Charles Henderson Middle', '2026-08-25T00:00:00+00:00'),
      ('troy-elementary-school', 'Troy Elementary School', '2026-08-25T00:00:00+00:00'),
      ('troypike-regional-center-for-technology', 'Troypike Regional Center For Technology', '2026-08-25T00:00:00+00:00'),
      ('rock-quarry-elementary-school', 'Rock Quarry Elementary School', '2026-08-25T00:00:00+00:00'),
      ('the-alberta-school-of-performing-arts', 'The Alberta School Of Performing Arts', '2026-08-25T00:00:00+00:00'),
      ('arcadia-elementary-school', 'Arcadia Elementary School', '2026-08-25T00:00:00+00:00'),
      ('central-elementary-school-4', 'Central Elementary School', '2026-08-25T00:00:00+00:00'),
      ('eastwood-middle-school', 'Eastwood Middle School', '2026-08-25T00:00:00+00:00'),
      ('oakdale-elementary-school', 'Oakdale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('skyland-elementary-school', 'Skyland Elementary School', '2026-08-25T00:00:00+00:00'),
      ('university-place-elementary-school', 'University Place Elementary School', '2026-08-25T00:00:00+00:00'),
      ('westlawn-middle-school', 'Westlawn Middle School', '2026-08-25T00:00:00+00:00'),
      ('woodland-forrest-elementary-school', 'Woodland Forrest Elementary School', '2026-08-25T00:00:00+00:00'),
      ('martin-l-king-jr-elementary-school', 'Martin L King Jr Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tuscaloosa-career-and-technology-academy', 'Tuscaloosa Career And Technology Academy', '2026-08-25T00:00:00+00:00'),
      ('central-high-school-5', 'Central High School', '2026-08-25T00:00:00+00:00'),
      ('verner-elementary-school', 'Verner Elementary School', '2026-08-25T00:00:00+00:00'),
      ('northridge-middle-school', 'Northridge Middle School', '2026-08-25T00:00:00+00:00'),
      ('paul-w-bryant-high-school', 'Paul W Bryant High School', '2026-08-25T00:00:00+00:00'),
      ('northridge-high-school', 'Northridge High School', '2026-08-25T00:00:00+00:00'),
      ('southview-elementary-school', 'Southview Elementary School', '2026-08-25T00:00:00+00:00'),
      ('tuscaloosa-magnet-school-middle', 'Tuscaloosa Magnet School  Middle', '2026-08-25T00:00:00+00:00'),
      ('tuscaloosa-magnet-school-elementary', 'Tuscaloosa Magnet School  Elementary', '2026-08-25T00:00:00+00:00'),
      ('hillcrest-high-school-2', 'Hillcrest High School', '2026-08-25T00:00:00+00:00'),
      ('tuscaloosa-county-juvenile-detention-center', 'Tuscaloosa County Juvenile Detention Center', '2026-08-25T00:00:00+00:00'),
      ('holt-elementary-school', 'Holt Elementary School', '2026-08-25T00:00:00+00:00'),
      ('brookwood-elementary-school-2', 'Brookwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('brookwood-high-school', 'Brookwood High School', '2026-08-25T00:00:00+00:00'),
      ('buhl-elementary-school', 'Buhl Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cottondale-elementary-school', 'Cottondale Elementary School', '2026-08-25T00:00:00+00:00'),
      ('crestmont-elementary-school', 'Crestmont Elementary School', '2026-08-25T00:00:00+00:00'),
      ('englewood-elementary-school', 'Englewood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('flatwoods-elementary-school', 'Flatwoods Elementary School', '2026-08-25T00:00:00+00:00'),
      ('hillcrest-middle-school', 'Hillcrest Middle School', '2026-08-25T00:00:00+00:00'),
      ('holt-high-school', 'Holt High School', '2026-08-25T00:00:00+00:00'),
      ('matthews-elementary-school', 'Matthews Elementary School', '2026-08-25T00:00:00+00:00'),
      ('maxwell-elementary-school', 'Maxwell Elementary School', '2026-08-25T00:00:00+00:00'),
      ('myrtlewood-elementary-school', 'Myrtlewood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('northside-high-school', 'Northside High School', '2026-08-25T00:00:00+00:00'),
      ('collinsriverside-middle-school', 'Collinsriverside Middle School', '2026-08-25T00:00:00+00:00'),
      ('tuscaloosa-county-high-school', 'Tuscaloosa County High School', '2026-08-25T00:00:00+00:00'),
      ('vance-elementary-school', 'Vance Elementary School', '2026-08-25T00:00:00+00:00'),
      ('faucettvestavia-elementary-school', 'Faucettvestavia Elementary School', '2026-08-25T00:00:00+00:00'),
      ('walker-elementary-school', 'Walker Elementary School', '2026-08-25T00:00:00+00:00'),
      ('westwood-elementary-school', 'Westwood Elementary School', '2026-08-25T00:00:00+00:00'),
      ('taylorville-primary-school', 'Taylorville Primary School', '2026-08-25T00:00:00+00:00'),
      ('echols-middle-school', 'Echols Middle School', '2026-08-25T00:00:00+00:00'),
      ('brookwood-middle-school', 'Brookwood Middle School', '2026-08-25T00:00:00+00:00'),
      ('huntington-place-elementary-school', 'Huntington Place Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lloyd-wood-education-center', 'Lloyd Wood Education Center', '2026-08-25T00:00:00+00:00'),
      ('northport-elementary-school', 'Northport Elementary School', '2026-08-25T00:00:00+00:00'),
      ('duncanville-middle-school', 'Duncanville Middle School', '2026-08-25T00:00:00+00:00'),
      ('lake-view-elementary-school', 'Lake View Elementary School', '2026-08-25T00:00:00+00:00'),
      ('northside-middle-school', 'Northside Middle School', '2026-08-25T00:00:00+00:00'),
      ('davisemerson-middle-school', 'Davisemerson Middle School', '2026-08-25T00:00:00+00:00'),
      ('sipsey-valley-high-school', 'Sipsey Valley High School', '2026-08-25T00:00:00+00:00'),
      ('sipsey-valley-middle-school', 'Sipsey Valley Middle School', '2026-08-25T00:00:00+00:00'),
      ('big-sandy-elementary', 'Big Sandy Elementary', '2026-08-25T00:00:00+00:00'),
      ('northport-intermediate-school', 'Northport Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('deshler-high-school', 'Deshler High School', '2026-08-25T00:00:00+00:00'),
      ('deshler-middle-school', 'Deshler Middle School', '2026-08-25T00:00:00+00:00'),
      ('r-e-thompson-intermediate-school', 'R E Thompson Intermediate School', '2026-08-25T00:00:00+00:00'),
      ('g-w-trenholm-primary-school', 'G W Trenholm Primary School', '2026-08-25T00:00:00+00:00'),
      ('deshler-career-technical-center', 'Deshler Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('deshler-alternative-school', 'Deshler Alternative School', '2026-08-25T00:00:00+00:00'),
      ('pizitz-middle-school', 'Pizitz Middle School', '2026-08-25T00:00:00+00:00'),
      ('east-elementary', 'East Elementary', '2026-08-25T00:00:00+00:00'),
      ('west-elementary', 'West Elementary', '2026-08-25T00:00:00+00:00'),
      ('vestavia-hills-high-school', 'Vestavia Hills High School', '2026-08-25T00:00:00+00:00'),
      ('liberty-park-elementary', 'Liberty Park Elementary', '2026-08-25T00:00:00+00:00'),
      ('vestavia-hills-elementary-cahaba-heights', 'Vestavia Hills Elementary Cahaba Heights', '2026-08-25T00:00:00+00:00'),
      ('liberty-park-middle-school', 'Liberty Park Middle School', '2026-08-25T00:00:00+00:00'),
      ('vestavia-hills-elementary-dolly-ridge', 'Vestavia Hills Elementary Dolly Ridge', '2026-08-25T00:00:00+00:00'),
      ('vestavia-hills-high-school-freshman-campus', 'Vestavia Hills High School Freshman Campus', '2026-08-25T00:00:00+00:00'),
      ('carbon-hill-elementaryjunior-high-school', 'Carbon Hill Elementaryjunior High School', '2026-08-25T00:00:00+00:00'),
      ('carbon-hill-high-school', 'Carbon Hill High School', '2026-08-25T00:00:00+00:00'),
      ('walker-county-schools-180-program', 'Walker County Schools 180 Program', '2026-08-25T00:00:00+00:00'),
      ('walker-county-center-of-technology', 'Walker County Center Of Technology', '2026-08-25T00:00:00+00:00'),
      ('bankhead-middle-school', 'Bankhead Middle School', '2026-08-25T00:00:00+00:00'),
      ('cordova-elementary-school', 'Cordova Elementary School', '2026-08-25T00:00:00+00:00'),
      ('cordova-high-school', 'Cordova High School', '2026-08-25T00:00:00+00:00'),
      ('curry-elementary-school', 'Curry Elementary School', '2026-08-25T00:00:00+00:00'),
      ('curry-high-school', 'Curry High School', '2026-08-25T00:00:00+00:00'),
      ('dora-high-school', 'Dora High School', '2026-08-25T00:00:00+00:00'),
      ('lupton-junior-high-school', 'Lupton Junior High School', '2026-08-25T00:00:00+00:00'),
      ('oakman-middle-school', 'Oakman Middle School', '2026-08-25T00:00:00+00:00'),
      ('oakman-high-school', 'Oakman High School', '2026-08-25T00:00:00+00:00'),
      ('parrish-elementarymiddle-school', 'Parrish Elementarymiddle School', '2026-08-25T00:00:00+00:00'),
      ('sumiton-middle-school', 'Sumiton Middle School', '2026-08-25T00:00:00+00:00'),
      ('valley-junior-high-school', 'Valley Junior High School', '2026-08-25T00:00:00+00:00'),
      ('curry-middle-school', 'Curry Middle School', '2026-08-25T00:00:00+00:00'),
      ('sumiton-elementary-school', 'Sumiton Elementary School', '2026-08-25T00:00:00+00:00'),
      ('washington-county-career-technical-center', 'Washington County Career Technical Center', '2026-08-25T00:00:00+00:00'),
      ('mcintosh-elementary-school', 'Mcintosh Elementary School', '2026-08-25T00:00:00+00:00'),
      ('chatom-elementary-school', 'Chatom Elementary School', '2026-08-25T00:00:00+00:00'),
      ('washington-county-high-school', 'Washington County High School', '2026-08-25T00:00:00+00:00'),
      ('fruitdale-high-school', 'Fruitdale High School', '2026-08-25T00:00:00+00:00'),
      ('leroy-high-school', 'Leroy High School', '2026-08-25T00:00:00+00:00'),
      ('mcintosh-high-school', 'Mcintosh High School', '2026-08-25T00:00:00+00:00'),
      ('millry-high-school', 'Millry High School', '2026-08-25T00:00:00+00:00'),
      ('f-s-ervin-elementary-school', 'F S Ervin Elementary School', '2026-08-25T00:00:00+00:00'),
      ('abc-elementary', 'Abc Elementary', '2026-08-25T00:00:00+00:00'),
      ('j-e-hobbs-elementary-school', 'J E Hobbs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('wilcox-county-alternative-school', 'Wilcox County Alternative School', '2026-08-25T00:00:00+00:00'),
      ('wilcox-central-high-school', 'Wilcox Central High School', '2026-08-25T00:00:00+00:00'),
      ('camden-school-of-arts-technology', 'Camden School Of Arts  Technology', '2026-08-25T00:00:00+00:00'),
      ('winfield-middle-school', 'Winfield Middle School', '2026-08-25T00:00:00+00:00'),
      ('winfield-high-school', 'Winfield High School', '2026-08-25T00:00:00+00:00'),
      ('winfield-elementary-school', 'Winfield Elementary School', '2026-08-25T00:00:00+00:00'),
      ('winston-county-technical-center', 'Winston County Technical Center', '2026-08-25T00:00:00+00:00'),
      ('addison-high-school', 'Addison High School', '2026-08-25T00:00:00+00:00'),
      ('winston-county-high-school', 'Winston County High School', '2026-08-25T00:00:00+00:00'),
      ('double-springs-elementary-school', 'Double Springs Elementary School', '2026-08-25T00:00:00+00:00'),
      ('lynn-high-school', 'Lynn High School', '2026-08-25T00:00:00+00:00'),
      ('meek-high-school', 'Meek High School', '2026-08-25T00:00:00+00:00'),
      ('addison-elementary-school', 'Addison Elementary School', '2026-08-25T00:00:00+00:00'),
      ('double-springs-middle-school', 'Double Springs Middle School', '2026-08-25T00:00:00+00:00'),
      ('lynn-elementary-school', 'Lynn Elementary School', '2026-08-25T00:00:00+00:00'),
      ('meek-elementary-school', 'Meek Elementary School', '2026-08-25T00:00:00+00:00'),
      ('orange-beach-elementary-school-2', 'Orange Beach Elementary School', '2026-08-25T00:00:00+00:00'),
      ('orange-beach-middlehigh-school-2', 'Orange Beach Middlehigh School', '2026-08-25T00:00:00+00:00'),
      ('empower-community-school', 'Empower Community School', '2026-08-25T00:00:00+00:00'),
      ('covenant-academy-of-mobile', 'Covenant Academy Of Mobile', '2026-08-25T00:00:00+00:00'),
      ('barnabas-school-of-leadership', 'Barnabas School Of Leadership', '2026-08-25T00:00:00+00:00')
    ON CONFLICT (id) DO NOTHING;
    
    """,
    # ── 32: pinned chats ─────────────────────────────────────────────────────
    """
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_pinned INTEGER NOT NULL DEFAULT 0;
    """,
    # ── 33: user avatars ─────────────────────────────────────────────────────
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
    """,
    # ── 50: don't let a bulk-seeded school claim to be ready ──────────────────
    #
    # Migration 28 defaulted template_status to 'active' back when Florence
    # was the only real row in this table. Migration 49's bulk insert of
    # ~1,600 Alabama schools didn't set template_status explicitly, so every
    # one of them silently inherited 'active' too — claiming a builder
    # exists when none of them have one. docx_build.builder() used to paper
    # over that by silently falling back to Florence's own builder for any
    # of them; now that it raises instead (see docx_build.py), these schools
    # need to actually BE 'pending' so OnboardingWizard's template-upload
    # step shows up for them, same as it already does for a school created
    # through create_school().
    """
    UPDATE schools SET template_status = 'pending'
    WHERE id != 'florence-high-school' AND template_status = 'active';

    ALTER TABLE schools ALTER COLUMN template_status SET DEFAULT 'pending';
    """,
    # ── 52: automated builder-spec codegen ─────────────────────────────────────
    #
    # template_status ('pending'/'active') means "we understand this school's
    # template structure" — it has never meant "we can generate documents in
    # it" (see docx_build.builder()'s AppError("builder_missing_for_school")).
    # builder_status is a deliberately SEPARATE axis tracking the new
    # generate-a-declarative-spec-and-visually-verify-it pipeline
    # (backend/builder/codegen.py), so template_status keeps meaning exactly
    # what every existing consumer (TemplateBanner, SettingsPage's status
    # pill, docx_build.builder()'s own gate) already assumes it means.
    #
    # builder_codegen_jobs is one row per (school, template) codegen attempt
    # series; builder_codegen_attempts is the full history of every attempt
    # within a job — layout spec, rendered sample, both vision-judge verdicts
    # — so a job that exhausts its retry budget hands a human a documented
    # set of near-misses to finish from, not a bare failure.
    """
    ALTER TABLE schools ADD COLUMN IF NOT EXISTS builder_status TEXT NOT NULL DEFAULT 'not_started';

    CREATE TABLE IF NOT EXISTS builder_codegen_jobs (
        id                TEXT PRIMARY KEY,
        school_id         TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        template_id       TEXT NOT NULL REFERENCES school_templates(id) ON DELETE CASCADE,
        status            TEXT NOT NULL DEFAULT 'queued',
        attempt_count     INTEGER NOT NULL DEFAULT 0,
        layout_spec_json  TEXT,
        error_message     TEXT,
        created_at        TEXT NOT NULL,
        started_at        TEXT,
        finished_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_builder_codegen_jobs_status ON builder_codegen_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_builder_codegen_jobs_school ON builder_codegen_jobs(school_id);
    ALTER TABLE builder_codegen_jobs ENABLE ROW LEVEL SECURITY;

    CREATE TABLE IF NOT EXISTS builder_codegen_attempts (
        id                 TEXT PRIMARY KEY,
        job_id             TEXT NOT NULL REFERENCES builder_codegen_jobs(id) ON DELETE CASCADE,
        attempt_number     INTEGER NOT NULL,
        layout_spec_json   TEXT NOT NULL,
        render_image_path  TEXT,
        judge1_json        TEXT,
        judge2_json        TEXT,
        passed             BOOLEAN NOT NULL DEFAULT false,
        created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_builder_codegen_attempts_job ON builder_codegen_attempts(job_id);
    ALTER TABLE builder_codegen_attempts ENABLE ROW LEVEL SECURITY;
    """,
    # ── 53: per-user beta features opt-in ──────────────────────────────────────
    #
    # Voice Mode is being gated behind this — SettingsPage.jsx's "Enable Beta
    # Features" toggle already existed but wrote to local React state only
    # (never persisted, reset on every reload). Same shape as avatar
    # (migration 33): a plain column, defaulting to off for every existing
    # account.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_features BOOLEAN NOT NULL DEFAULT false;
    """,
    # ── 54: which messages came from Voice Mode ─────────────────────────────────
    #
    # NULL for every message typed as text (which is all of them until now);
    # 'voice' for one whose content is Voice Mode's speech-to-text output —
    # see add_message's own docstring for why this is worth tracking
    # separately rather than storing spoken and typed content identically.
    """
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT;
    """,
    # ── 55: auto-verify a builder codegen job on the cleanest pass ──────────────
    #
    # codegen.py's module docstring (and approve_builder_codegen_job's own)
    # used to say approval is ALWAYS an explicit admin action, full stop —
    # that was a deliberate pilot-phase gate (the vision judge had zero
    # production track record), not an oversight. It's being narrowed here,
    # not removed: auto-verify only fires when BOTH independent quality
    # signals this codebase already trusts enough to act on alone agree —
    # the template's own analysis was clean enough to auto-activate
    # (school_templates.auto_activated, migration ~47ish's bar: zero
    # findings, confidence>=0.9, model recommends it) AND this codegen job
    # passed both vision judges within its attempt budget (status ==
    # 'succeeded'). Anything short of that still waits for a human, exactly
    # as before.
    #
    # auto_verified distinguishes this path from an admin's manual approve —
    # both set schools.builder_status='verified' identically, but list_
    # auto_verified_builder_jobs (the post-hoc audit trail, mirroring
    # list_auto_activated_templates) needs to tell which is which.
    # verified_at is set on the manual path too now, for symmetry — it was
    # simply absent before since builder_status itself already carried "when"
    # implicitly via the schools row having no timestamp at all.
    """
    ALTER TABLE builder_codegen_jobs ADD COLUMN IF NOT EXISTS auto_verified BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE builder_codegen_jobs ADD COLUMN IF NOT EXISTS verified_at TEXT;
    """,
    # ── 56: close the remaining RLS gaps ─────────────────────────────────────
    #
    # Two tables never got migration 12's treatment at all: audit_log
    # (migration 47) and global_standards (created outside this migration
    # list entirely, by a one-off data-load script) both shipped with RLS
    # disabled — Supabase's advisor flags both as CRITICAL: the anon key,
    # meant to ship in frontend code, could read and write either directly
    # over PostgREST, no login required. Neither gets a policy, same as
    # every other table this codebase locks down with no legitimate direct
    # caller (migration 12's own reasoning): the app connects as `postgres`
    # (BYPASSRLS), so RLS-enabled-with-zero-policies is "invisible to the
    # app, a total blackout for anon/authenticated" — exactly what a pure
    # audit trail and a shared reference table should be.
    #
    # Everything else below is defense-in-depth, not a new gap: every one of
    # these tables already had RLS enabled (migration 20 or its own CREATE
    # TABLE) with zero policies, which already means zero rows for anon/
    # authenticated — deny-all is strictly tighter than "only your own
    # rows." This adds migration 20's per-account policy to every remaining
    # table that has real per-account data (a user_id column, or one reachable
    # through a single join), so the SAME explicit "only your own account"
    # rule governs every one of them consistently — not relying on some
    # tables being silently locked by omission and others by an explicit
    # policy. If this app's connection role ever changes and stops
    # bypassing RLS, every account-scoped table fails the same safe way
    # instead of some doing so by accident and others not at all.
    #
    # plan_shares has no user_id of its own (it's keyed by email, the point
    # of sharing being letting someone else in) — scoped through the plan it
    # shares, same shape as messages' own through-chats policy above. Tables
    # intentionally left alone (schools, school_templates,
    # school_calendar_submissions, builder_codegen_jobs/attempts, app_settings,
    # admin_audit_log, chunks, llm_cache, schema_version) are either not
    # account-scoped data at all or admin/system-managed — already correctly
    # deny-all, and a policy there would be inventing an account-ownership
    # model that doesn't exist.
    """
    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE global_standards ENABLE ROW LEVEL SECURITY;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own account" ON users USING (id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own settings" ON settings USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own quizzes" ON quizzes USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own Drive tokens" ON google_drive_tokens USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own usage events" ON usage_events USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own curriculum progress" ON curriculum_progress USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE POLICY "Users can access their own curriculum chunks" ON curriculum_chunks USING (user_id = current_setting('app.user_id', true));
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    -- Through plans, because plan_shares has no user_id of its own.
    DO $$ BEGIN
        CREATE POLICY "Users can access shares of their own plans" ON plan_shares USING (
            plan_id IN (SELECT id FROM plans WHERE user_id = current_setting('app.user_id', true))
        );
    EXCEPTION WHEN duplicate_object THEN null; END $$;
    """,
    # ── 57: never retain a visually rejected auto-verified builder ───────────
    """
    UPDATE builder_codegen_jobs j
    SET status = 'failed_needs_human',
        auto_verified = false,
        verified_at = NULL,
        error_message = 'Auto-verification revoked: no attempt passed both visual judges.'
    WHERE j.auto_verified = true
      AND NOT EXISTS (
        SELECT 1 FROM builder_codegen_attempts a
        WHERE a.job_id = j.id AND a.passed = true
      );

    UPDATE schools s
    SET builder_status = 'not_started'
    WHERE s.builder_status = 'verified'
      AND EXISTS (
        SELECT 1 FROM builder_codegen_jobs j
        WHERE j.school_id = s.id
          AND j.status = 'failed_needs_human'
          AND j.error_message = 'Auto-verification revoked: no attempt passed both visual judges.'
      );
    """,
    # ── 58: durable DOCX builds ─────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS document_build_jobs (
      plan_id TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','ready','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_build_jobs_status ON document_build_jobs(status, updated_at);
    ALTER TABLE document_build_jobs ENABLE ROW LEVEL SECURITY;
    """,
    # ── 59: bounded automatic recovery for durable DOCX builds ────────────
    """
    ALTER TABLE document_build_jobs ADD COLUMN IF NOT EXISTS available_at TEXT;
    UPDATE document_build_jobs SET available_at = updated_at WHERE available_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_document_build_jobs_ready
      ON document_build_jobs(status, available_at);
    """,
    # ── 60: explicit AI output-length preference ────────────────────────────
    # Response Length used to live only as a prose tag inside
    # users.custom_instructions. That meant the model saw a suggestion but the
    # API always allowed the same completion budget, and changing the tag could
    # still hit a cached result made under a different budget. Keep the
    # preference as data so generation can enforce it. The default preserves
    # the current Medium behavior; the two backfills retain Short/Long choices
    # already saved in the old tag form.
    """
    ALTER TABLE users ADD COLUMN IF NOT EXISTS output_length TEXT NOT NULL DEFAULT 'medium';
    UPDATE users
       SET output_length = 'short'
     WHERE LOWER(COALESCE(custom_instructions, '')) LIKE '%[response length: short]%'
       AND output_length = 'medium';
    UPDATE users
       SET output_length = 'long'
     WHERE LOWER(COALESCE(custom_instructions, '')) LIKE '%[response length: long]%'
       AND output_length = 'medium';
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_output_length_check;
    ALTER TABLE users ADD CONSTRAINT users_output_length_check
      CHECK (output_length IN ('short', 'medium', 'long'));
    """,
]


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _dsn_with_tls() -> str:
    """DATABASE_URL, with sslmode=require added if the URL didn't already pick
    one. Supabase's pooler accepts plaintext as well as TLS, so an operator
    who copies a bare connection string in gets an encrypted connection
    anyway rather than a silent unencrypted one — student-adjacent data
    (teacher accounts, essays pasted into chat, curriculum text) shouldn't
    ride the wire in the clear regardless of what the DSN happened to omit.
    "require" (not "verify-full"): the pooler's cert isn't pinned here, so
    this stops passive eavesdropping without also needing a bundled CA file.
    """
    url = settings.database_url
    if "sslmode=" in url:
        return url
    return url + ("&" if "?" in url else "?") + "sslmode=require"


def _new_connection() -> psycopg2.extensions.connection:
    if not settings.database_url:
        raise ValueError("DATABASE_URL is not set in .env")

    try:
        conn = psycopg2.connect(_dsn_with_tls(), cursor_factory=RealDictCursor)
    except psycopg2.OperationalError as exc:
        # Every data route died with a generic "Something went wrong on the
        # server" when this happened, which sent you to the logs to find out the
        # database simply wasn't reachable. The overwhelmingly common cause is
        # Supabase's move to IPv6-only direct connections: db.<ref>.supabase.co
        # has no A record any more, so a host without IPv6 egress gets
        # "No route to host". The pooler is dual-stack, which is the fix.
        detail = str(exc).strip().splitlines()[0] if str(exc).strip() else "connection failed"
        hint = (
            "Check DATABASE_URL. If the host is db.<ref>.supabase.co it resolves "
            "IPv6-only, and any machine without IPv6 egress cannot reach it — "
            "switch to the Supabase connection pooler instead (Project Settings "
            "→ Database → Connection pooling). Note the username becomes "
            "postgres.<project-ref>."
        )
        raise AppError("database_unreachable", f"Can't reach the database: {detail}", status=503, hint=hint) from exc

    conn.autocommit = False

    try:
        register_vector(conn)
    except psycopg2.ProgrammingError:
        pass

    return conn


def connect() -> None:
    """Open the pool and run migrations. Called once at startup.

    No longer returns a connection: it used to hand out THE shared one, and a
    caller holding a pooled connection past the borrow is how a pool leaks
    itself empty. Anything needing a connection should use `borrow()`.
    """
    _ensure_pool()
    with borrow() as conn:
        migrate(conn)
    log.info("db connected to Supabase")


def _ensure_pool() -> ThreadedConnectionPool:
    """One pool per process, created on first use.

    THIS is what lets two teachers generate at the same time.

    Before: one module-level connection, and every read and write in the app
    took a single global lock around it. Measured, nine concurrent queries ran
    1.36x faster than nine sequential ones — i.e. essentially serialised. A
    generation issues ~30 pgvector reads, so a second teacher spent the whole of
    the first teacher's retrieval waiting for a lock rather than for a database.

    maxconn is deliberately small. Supabase's pooler has a connection ceiling
    and this app can run as several processes (or, on a serverless host, several
    warm instances), each with its own pool — so the budget is per-process
    conservative rather than per-process greedy.
    """
    global _pool, _slots
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            if not settings.database_url:
                raise ValueError("DATABASE_URL is not set in .env")
            # The semaphore is not redundant. psycopg2's ThreadedConnectionPool
            # RAISES "connection pool exhausted" rather than waiting, so the
            # 9th concurrent request would get a 500 instead of queueing for a
            # few milliseconds. This makes callers wait, which is what everyone
            # means by "pool".
            _slots = threading.Semaphore(settings.db_pool_size)
            _pool = ThreadedConnectionPool(
                minconn=1,
                maxconn=settings.db_pool_size,
                dsn=_dsn_with_tls(),
                cursor_factory=RealDictCursor,
                # Without this, a Supabase pooler that silently drops packets
                # (rather than refusing the connection) leaves libpq retrying
                # at the TCP level with no exception ever raised — the request
                # thread blocks forever and FastAPI never sends a response.
                connect_timeout=10,
            )
            log.info("db pool opened (max %d connections)", settings.db_pool_size)
    return _pool


@contextmanager
def borrow():
    """Borrow a connection for the duration of one statement, and always give it
    back — including on the error paths, which is the failure mode that turns a
    pool into an outage."""
    pool = _ensure_pool()
    # A bounded wait: if every slot is leaked (e.g. a worker thread killed
    # mid-request never released one), callers should get a 500 instead of
    # blocking forever with no exception and no response ever sent.
    if not _slots.acquire(timeout=15):
        raise TimeoutError("Timed out waiting for a database connection slot.")
    try:
        conn = pool.getconn()
        user_id = current_user_id.get()
        if user_id:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL app.user_id = %s", (user_id,))
    except Exception:
        _slots.release()
        raise
    try:
        if conn.closed:
            # A pooler can drop an idle connection; don't hand a dead one out.
            pool.putconn(conn, close=True)
            conn = pool.getconn()
        # ONCE per physical connection, not once per query. register_vector
        # issues its own round trip to look up the vector type's OID, and doing
        # that on every borrow made concurrent reads SLOWER than sequential
        # ones — the pool was winning and this was handing the win back.
        if not getattr(conn, "_vector_registered", False):
            try:
                register_vector(conn)
                conn._vector_registered = True
            except (psycopg2.ProgrammingError, psycopg2.InterfaceError):
                pass
        yield conn
    except Exception:
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001, S110 — best-effort cleanup, the original error below still propagates
            pass
        raise
    finally:
        pool.putconn(conn)
        _slots.release()


def migrate(conn: psycopg2.extensions.connection) -> None:
    # Startup runs once per worker.  Serialize the append-only migration list
    # so two workers cannot both observe the same version and execute the same
    # non-idempotent historical migration at once.
    lock_key = 827364019
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(%s)", (lock_key,))
    try:
        with conn.cursor() as cur:
            cur.execute('''
                CREATE TABLE IF NOT EXISTS schema_version (
                    version INTEGER PRIMARY KEY
                )
            ''')
            cur.execute('SELECT MAX(version) FROM schema_version')
            version_row = cur.fetchone()
            version = version_row['max'] if version_row and version_row['max'] is not None else 0

            if version > len(MIGRATIONS):
                raise RuntimeError(
                    f"Database schema version {version} is newer than this app ({len(MIGRATIONS)})."
                )
            for i, script in enumerate(MIGRATIONS[version:], start=version):
                log.info("applying migration %d", i + 1)
                cur.execute(script)
                cur.execute("INSERT INTO schema_version (version) VALUES (%s) ON CONFLICT (version) DO NOTHING", (i + 1,))
                conn.commit()

            try:
                register_vector(conn)
            except psycopg2.ProgrammingError:
                pass
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
        except Exception:  # noqa: BLE001 — recovers by rolling back and retrying the unlock below
            # A failed migration leaves the transaction aborted, so the first
            # unlock attempt may itself be rejected. Clear that transaction
            # before releasing the session-level lock and preserving the
            # original migration error for the caller.
            conn.rollback()
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))


def close() -> None:
    global _pool
    if _pool is not None:
        _pool.closeall()
        _pool = None


def _write(sql: str, params: tuple = ()) -> int:
    with borrow() as conn:
        with conn.cursor() as cur:
            # psycopg2 uses %s for placeholders instead of ?
            cur.execute(sql.replace("?", "%s"), params)
            rowcount = cur.rowcount
        conn.commit()
        return rowcount


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    with borrow() as conn, conn.cursor() as cur:
        cur.execute(sql.replace("?", "%s"), params)
        return [dict(r) for r in cur.fetchall()]


def _row(sql: str, params: tuple = ()) -> dict | None:
    with borrow() as conn, conn.cursor() as cur:
        cur.execute(sql.replace("?", "%s"), params)
        r = cur.fetchone()
        return dict(r) if r else None


def _write_returning(sql: str, params: tuple = ()) -> dict | None:
    """Like _write, but for a write statement with a RETURNING clause whose
    result the caller needs — e.g. an atomic
    `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`
    claim. _row/_rows never commit (read-only callers rely on that), so using
    either of them here would leave the write uncommitted until the pooled
    connection is reused for something else — this commits explicitly, same
    as _write."""
    with borrow() as conn:
        with conn.cursor() as cur:
            cur.execute(sql.replace("?", "%s"), params)
            r = cur.fetchone()
        conn.commit()
        return dict(r) if r else None


# ---------------------------------------------------------------------------
# Settings (singleton)
# ---------------------------------------------------------------------------

# The shape a settings row falls back to when one is created lazily for a
# subject that has never had one.
#
# `teacher` was "Josh Cole" and `period` "3rd period" — this app's author, left
# over from when it was a single-user tool. The normal path overwrites both
# (create_class -> sync_settings_from_class), so it stayed invisible, but
# get_settings_row below will happily INSERT this for any subject with no row
# yet — and `teacher` is printed in the document header. Another teacher's
# name appearing on a stranger's lesson plan is not a cosmetic default.
#
# Empty rather than a placeholder like "Teacher": the builder already handles a
# blank header field, and a wrong name is worse than a missing one. The real
# name is filled in by get_settings_row from the account itself.
DEFAULT_SETTINGS = {
    "teacher": "",
    "course": "",
    "period": "",
    "subject": "General",
    "grade": "",
}


def get_settings_row(user_id: str = "default_user", subject: str | None = None) -> dict:
    if subject is not None:
        row = _row("SELECT * FROM settings WHERE user_id = ? AND subject = ?", (user_id, subject))
    else:
        # Get the most recently updated settings profile for this user
        row = _row("SELECT * FROM settings WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", (user_id,))
        
    if row is None:
        target_subject = subject or DEFAULT_SETTINGS["subject"]
        # The account's own name, not DEFAULT_SETTINGS' empty one, whenever we
        # have it — this row's `teacher` is what prints in the document header,
        # so the one thing worth doing here is getting it right rather than
        # leaving it for a later sync that may never come. Falls back to the
        # (now blank) default for a user id with no row, e.g. 'default_user' in
        # local dev before anyone has signed up.
        owner = _row("SELECT name FROM users WHERE id = ?", (user_id,))
        teacher = (owner["name"] if owner and owner.get("name") else DEFAULT_SETTINGS["teacher"])
        # `subject` doubles as the course label on a lazily-created row: it is
        # the only thing the caller actually told us about this profile, and
        # it beats a hardcoded course belonging to a different school.
        course = target_subject if subject else DEFAULT_SETTINGS["course"]
        _write(
            "INSERT INTO settings (user_id, subject, teacher, course, period, grade, updated_at) VALUES (?,?,?,?,?,?,?)",
            (
                user_id,
                target_subject,
                teacher,
                course,
                DEFAULT_SETTINGS["period"],
                DEFAULT_SETTINGS["grade"],
                now(),
            ),
        )
        row = _row("SELECT * FROM settings WHERE user_id = ? AND subject = ?", (user_id, target_subject))
    return dict(row)  # type: ignore[arg-type]


def update_settings(user_id: str, teacher: str, course: str, period: str, subject: str = "AP Language & Composition", grade: str = "11") -> dict:
    # Upsert the settings for this user and subject
    _write(
        """
        INSERT INTO settings (user_id, subject, teacher, course, period, grade, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, subject) DO UPDATE SET
            teacher=excluded.teacher,
            course=excluded.course,
            period=excluded.period,
            grade=excluded.grade,
            updated_at=excluded.updated_at
        """,
        (user_id, subject, teacher, course, period, grade, now()),
    )
    return get_settings_row(user_id, subject)


# ---------------------------------------------------------------------------
# Classes
#
# A teacher's preps. This is what `settings` was standing in for: its
# (user_id, subject) primary key meant one class per standards framework, so two
# ELA courses could not coexist, and the teacher's name was stored once per row
# instead of once per teacher.
#
# `settings` is deliberately left in place and still written. Six call sites
# resolve identity through get_settings_row() — service.prepare/finalize/
# revise_day, generate.chat_stream, plans.patch/revise — and retrieval scopes on
# the subject code it returns. Keeping the two in step means classes can land
# without touching the generate path in the same change.
# ---------------------------------------------------------------------------


def list_classes(user_id: str, include_archived: bool = False) -> list[dict]:
    where = "" if include_archived else " AND archived = 0"
    return _rows(
        f"SELECT * FROM classes WHERE user_id = ?{where} ORDER BY sort_order, created_at",
        (user_id,),
    )


def get_class(user_id: str, class_id: str) -> dict | None:
    return _row("SELECT * FROM classes WHERE id = ? AND user_id = ?", (class_id, user_id))


_GRADE_ORDINAL = re.compile(r"^\s*(\d{1,2})\s*(?:st|nd|rd|th)\s*$", re.IGNORECASE)


def normalize_grade(grade: Any) -> Any:
    """"11th" -> "11". The write-side guard behind migration 38.

    That migration cleans the rows one already-fixed client wrote; this keeps
    the column honest going forward, for the same reason the fix has to exist
    in two places at all: a label in this column does not fail loudly. It
    fails as service._resolve_subject_grade's int() falling back to grade 11
    and retrieving another grade's standards under real-looking codes —
    exactly the silent-wrong-answer case retrieval.py warns about, since every
    grade re-uses standard numbers 1-30.

    Anything that isn't an ordinal is passed through untouched (None, 'K', a
    bare number, whatever a future framework needs) — narrow on purpose, so
    this can only ever undo the one bad shape it was written for.
    """
    if not isinstance(grade, str):
        return grade
    m = _GRADE_ORDINAL.match(grade)
    return m.group(1) if m else grade


def create_class(user_id: str, *, name: str, subject: str, grade: str, state: str | None = None) -> dict:
    class_id = new_id()
    row = _row("SELECT COALESCE(MAX(sort_order), -1) AS m FROM classes WHERE user_id = ?", (user_id,))
    # Stamped with the account's CURRENT default school, not left NULL — a
    # fresh class gets an honest answer to "which calendar" from the start
    # (see migration 25), and can still be pointed at a different school
    # later without that touching the account default other classes read.
    _write(
        """
        INSERT INTO classes (id, user_id, name, subject, grade, state, school, sort_order, archived, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        """,
        (
            class_id,
            user_id,
            name.strip()[:120],
            subject,
            str(normalize_grade(grade)),
            state,
            get_user_school(user_id),
            int(row["m"]) + 1,
            now(),
        ),
    )
    # Mirror into settings so the generate path, which still reads
    # get_settings_row(user_id), sees this class the moment it is created.
    sync_settings_from_class(user_id, class_id)
    return get_class(user_id, class_id)


_CLASS_FIELDS = {"name", "subject", "grade", "sort_order", "archived", "school", "custom_instructions"}


def class_school(cls: dict | None, user_id: str) -> str:
    """Which calendar a class follows — its own pinned school (migration 25)
    if it has one, else the account default (get_user_school).

    The fallback matters for two real cases, not just missing data: a class
    created before this column existed, and `cls=None` itself — every caller
    that resolves a class from a chat_id (routes/generate.py's chat_stream,
    /generate, /generate_stream) gets None for a legacy chat with no
    class_id, and still needs a school to hand schoolcal."""
    if cls and cls.get("school"):
        return cls["school"]
    return get_user_school(user_id)


def update_class(user_id: str, class_id: str, **fields: Any) -> dict | None:
    sets = {k: v for k, v in fields.items() if k in _CLASS_FIELDS and v is not None}
    if "grade" in sets:
        sets["grade"] = normalize_grade(sets["grade"])
    if not sets:
        return get_class(user_id, class_id)
    clause = ", ".join(f"{k} = ?" for k in sets)
    _write(
        f"UPDATE classes SET {clause} WHERE id = ? AND user_id = ?",
        (*sets.values(), class_id, user_id),
    )
    sync_settings_from_class(user_id, class_id)
    return get_class(user_id, class_id)


def delete_class(user_id: str, class_id: str) -> bool:
    # Archive rather than delete. Plans reference the class and are the only
    # copy of a week's work; ON DELETE SET NULL would orphan them into the same
    # undifferentiated pile classes exist to break up.
    return _write("UPDATE classes SET archived = 1 WHERE id = ? AND user_id = ?", (class_id, user_id)) > 0


def sync_settings_from_class(user_id: str, class_id: str) -> None:
    """Keep the legacy settings row in step with a class.

    settings is keyed (user_id, subject) and everything downstream of generate
    still reads it, so a class is projected onto it: name -> course, and the
    teacher's name comes from users.name rather than being retyped per class.
    Touching updated_at is what makes get_settings_row(user_id) — which resolves
    'current' as ORDER BY updated_at DESC — return this class next."""
    cls = get_class(user_id, class_id)
    if not cls:
        return
    user = get_user_by_id(user_id) or {}
    prev = _row("SELECT period FROM settings WHERE user_id = ? AND subject = ?", (user_id, cls["subject"]))
    update_settings(
        user_id,
        teacher=(user.get("name") or DEFAULT_SETTINGS["teacher"]),
        course=cls["name"],
        period=(prev or {}).get("period", ""),
        subject=cls["subject"],
        grade=cls["grade"],
    )


def resolve_class(user_id: str, class_id: str | None = None) -> dict | None:
    """The class a request is about: the one asked for, else the first one.

    Returns None when a teacher has no classes yet — callers fall back to the
    settings row, which is what every pre-classes install has."""
    if class_id:
        cls = get_class(user_id, class_id)
        if cls:
            return cls
    rows = list_classes(user_id)
    return rows[0] if rows else None


# ---------------------------------------------------------------------------
# Schools — the curated calendar list (migration 23)
# ---------------------------------------------------------------------------


def list_schools() -> list[dict]:
    """Every registered school, alphabetically — what onboarding's picker and
    the admin page both read. Public reference data, no user_id scoping."""
    return _rows("SELECT * FROM schools ORDER BY name")


def get_school(school_id: str) -> dict | None:
    return _row("SELECT * FROM schools WHERE id = ?", (school_id,))


def create_school(school_id: str, name: str) -> dict:
    _write(
        "INSERT INTO schools (id, name, template_status, created_at) VALUES (?,?,'pending',?) ON CONFLICT (id) DO NOTHING",
        (school_id, name.strip(), now()),
    )
    return get_school(school_id)  # type: ignore[return-value]

def update_school_template_status(school_id: str, status: str) -> bool:
    changed = _write("UPDATE schools SET template_status = ? WHERE id = ?", (status, school_id)) > 0
    if changed:
        # docx_build.builder() is lru_cached per school_id — without this, a
        # school whose FIRST generation ever happened before this activation
        # (the common case: a teacher tries the app, gets the generic
        # fallback, then their upload gets approved) keeps silently getting
        # that same cached fallback module forever, no matter what template
        # status says now. See the other two call sites that flip
        # builder_status='verified' for the same fix.
        from . import docx_build
        docx_build.builder.cache_clear()
    return changed

def create_school_template(school_id: str, uploaded_by: str, filename: str, file_path: str) -> dict:
    template_id = new_id()
    _write(
        """
        INSERT INTO school_templates (id, school_id, uploaded_by, filename, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (template_id, school_id, uploaded_by, filename, file_path, now())
    )
    return _row("SELECT * FROM school_templates WHERE id = ?", (template_id,))  # type: ignore[return-value]

def list_pending_school_templates() -> list[dict]:
    return _rows(
        """
        SELECT st.*, s.name as school_name, u.name as uploader_name, u.email as uploader_email
        FROM school_templates st
        JOIN schools s ON st.school_id = s.id
        LEFT JOIN users u ON st.uploaded_by = u.id
        WHERE s.template_status = 'pending'
        ORDER BY st.created_at DESC
        """
    )

def get_school_template(template_id: str) -> dict | None:
    return _row("SELECT * FROM school_templates WHERE id = ?", (template_id,))

def get_latest_school_template(school_id: str) -> dict | None:
    return _row(
        """
        SELECT st.*, u.email as uploader_email, u.name as uploader_name
        FROM school_templates st
        LEFT JOIN users u ON st.uploaded_by = u.id
        WHERE st.school_id = ?
        ORDER BY st.created_at DESC
        LIMIT 1
        """,
        (school_id,)
    )


# ---------------------------------------------------------------------------
# Template structural analysis — see migration 33's comment for the shape.
# ---------------------------------------------------------------------------


def set_template_analysis_status(template_id: str, status: str) -> None:
    """Marks a template 'analyzing' before the pipeline starts, so a template
    stuck mid-run (worker crash, deploy) reads as 'analyzing' rather than
    silently 'pending' forever — visibly different from "never started"."""
    _write(
        "UPDATE school_templates SET analysis_status = ? WHERE id = ?",
        (status, template_id),
    )


def save_template_analysis(
    template_id: str,
    *,
    status: str,
    structure_json: str | None,
    analysis_summary: str | None,
    analysis_error: str | None = None,
) -> dict:
    """Terminal write for one analysis run — always sets analyzed_at, even
    for a 'failed' outcome, since 'when did we last try' matters as much as
    the result for an admin deciding whether to re-run it."""
    _write(
        """
        UPDATE school_templates
        SET analysis_status = ?, structure_json = ?, analysis_summary = ?,
            analysis_error = ?, analyzed_at = ?
        WHERE id = ?
        """,
        (status, structure_json, analysis_summary, analysis_error, now(), template_id),
    )
    return get_school_template(template_id)  # type: ignore[return-value]


def replace_template_findings(template_id: str, findings: list[dict]) -> None:
    """Wipes and rewrites the finding ledger for one template per analysis
    run — findings describe the CURRENT file's current analysis, not a
    history, so a re-analysis (a corrected template re-uploaded, or a manual
    re-run) should not leave stale findings from a previous run behind."""
    _write("DELETE FROM school_template_findings WHERE template_id = ?", (template_id,))
    for f in findings:
        _write(
            """
            INSERT INTO school_template_findings
                (id, template_id, stage, check_name, severity, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (new_id(), template_id, f["stage"], f["check_name"], f["severity"], f["message"], now()),
        )


def mark_template_auto_activated(template_id: str) -> None:
    _write("UPDATE school_templates SET auto_activated = true WHERE id = ?", (template_id,))


def list_auto_activated_templates(limit: int = 20) -> list[dict]:
    """The only place an auto-activated school is still visible as such —
    it no longer appears in list_pending_school_templates once its
    template_status flips to 'active', so this is what lets an admin see
    what the pipeline decided on its own, after the fact, without needing
    to go looking for it."""
    return _rows(
        """
        SELECT st.*, s.name as school_name, u.name as uploader_name, u.email as uploader_email
        FROM school_templates st
        JOIN schools s ON st.school_id = s.id
        LEFT JOIN users u ON st.uploaded_by = u.id
        WHERE st.auto_activated = true
        ORDER BY st.analyzed_at DESC
        LIMIT ?
        """,
        (limit,),
    )


def get_template_findings(template_id: str) -> list[dict]:
    return _rows(
        """
        SELECT * FROM school_template_findings
        WHERE template_id = ?
        ORDER BY
            CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
            stage, created_at
        """,
        (template_id,),
    )


# ---------------------------------------------------------------------------
# Builder codegen (migration 52) — declarative layout-spec generation +
# visual verification for a school with no hand-written {school_id}_builder.py.
# See backend/builder/codegen.py for the attempt loop that drives these.
# ---------------------------------------------------------------------------


def count_builder_codegen_jobs_created_since(since_iso: str) -> int:
    """Backs the daily job cap (settings.builder_codegen_max_jobs_per_day) —
    a ceiling on how many codegen jobs may START in a rolling window,
    independent of entitlement.py (which gates per-teacher plan generation
    spend, not a school-onboarding pipeline no single teacher requested)."""
    row = _row("SELECT COUNT(*) AS n FROM builder_codegen_jobs WHERE created_at >= ?", (since_iso,))
    return int(row["n"]) if row else 0


def enqueue_builder_codegen_job(school_id: str, template_id: str) -> dict:
    job_id = new_id()
    _write(
        """
        INSERT INTO builder_codegen_jobs (id, school_id, template_id, status, created_at)
        VALUES (?, ?, ?, 'queued', ?)
        """,
        (job_id, school_id, template_id, now()),
    )
    return get_builder_codegen_job(job_id)  # type: ignore[return-value]


def claim_next_builder_codegen_job() -> dict | None:
    """Atomically claims and marks 'running' the oldest 'queued' job, or
    returns None if none is waiting. FOR UPDATE SKIP LOCKED means two worker
    processes polling at once can never claim the same row — the second
    simply skips it and sees nothing to claim this round, rather than
    blocking on the first's lock."""
    return _write_returning(
        """
        UPDATE builder_codegen_jobs
        SET status = 'running', started_at = ?
        WHERE id = (
            SELECT id FROM builder_codegen_jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
        """,
        (now(),),
    )


def reset_stale_running_builder_codegen_jobs(stale_after_seconds: int = 1800) -> int:
    """Startup sweep: a job left 'running' by a process that died or was
    restarted mid-job would otherwise sit invisible forever (never re-polled,
    since claim_next_builder_codegen_job only looks at 'queued'). Reset it
    back to 'queued' so it resumes instead of leaking a zombie row — its
    attempt history in builder_codegen_attempts is untouched, so the next
    run picks up with that context intact via generate_layout_spec's
    prior_feedback, not from scratch."""
    return _write(
        """
        UPDATE builder_codegen_jobs
        SET status = 'queued'
        WHERE status = 'running'
          AND started_at < ?
        """,
        ((datetime.now(UTC) - timedelta(seconds=stale_after_seconds)).isoformat(timespec="seconds"),),
    )


def get_builder_codegen_job(job_id: str) -> dict | None:
    return _row("SELECT * FROM builder_codegen_jobs WHERE id = ?", (job_id,))


def get_builder_codegen_job_for_school(school_id: str) -> dict | None:
    return _row(
        "SELECT * FROM builder_codegen_jobs WHERE school_id = ? ORDER BY created_at DESC LIMIT 1",
        (school_id,),
    )


def active_builder_codegen_school_ids() -> set[str]:
    """Every school with a codegen job actively queued or running right
    now — ONE query total, not one per school (same reasoning as
    schoolcal.bulk_calendar_status: GET /api/schools lists ~1,600 rows, and
    a per-school SELECT here would be that same slow-hang mistake again;
    matches bulk_calendar_status's own shape of fetching the whole active
    set unfiltered rather than building a dynamic IN (...) list). Used to
    show a genuine "drafting your school's format now" loading state
    (TemplateBanner) instead of the flatter 'pending' — a teacher watching
    an upload sit at "pending" with no sense that anything is actually
    happening reads as broken, not as busy."""
    rows = _rows("SELECT DISTINCT school_id FROM builder_codegen_jobs WHERE status IN ('queued', 'running')")
    return {r["school_id"] for r in rows}


def list_builder_codegen_jobs_pending_review() -> list[dict]:
    """Jobs an admin still needs to act on: exhausted their retry budget, or
    passed but haven't been auto-verified or explicitly approved yet. A job
    whose template was cleanly auto-activated AND that itself passed both
    vision judges never reaches this list at all — it self-verifies via
    mark_builder_codegen_job_auto_verified and shows up in
    list_auto_verified_builder_jobs instead. See backend/builder/codegen.py's
    module docstring for the exact bar."""
    return _rows(
        """
        SELECT j.*, s.name AS school_name, s.builder_status AS school_builder_status
        FROM builder_codegen_jobs j
        JOIN schools s ON s.id = j.school_id
        WHERE j.status IN ('failed_needs_human', 'succeeded')
          AND s.builder_status != 'verified'
        ORDER BY j.created_at DESC
        """
    )


def record_builder_codegen_attempt(
    job_id: str,
    *,
    attempt_number: int,
    layout_spec_json: str,
    render_image_path: str | None,
    judge1_json: str | None,
    judge2_json: str | None,
    passed: bool,
) -> dict:
    attempt_id = new_id()
    _write(
        """
        INSERT INTO builder_codegen_attempts
            (id, job_id, attempt_number, layout_spec_json, render_image_path, judge1_json, judge2_json, passed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (attempt_id, job_id, attempt_number, layout_spec_json, render_image_path, judge1_json, judge2_json, passed, now()),
    )
    _write("UPDATE builder_codegen_jobs SET attempt_count = ? WHERE id = ?", (attempt_number, job_id))
    return _row("SELECT * FROM builder_codegen_attempts WHERE id = ?", (attempt_id,))  # type: ignore[return-value]


def list_builder_codegen_attempts(job_id: str) -> list[dict]:
    return _rows(
        "SELECT * FROM builder_codegen_attempts WHERE job_id = ? ORDER BY attempt_number ASC",
        (job_id,),
    )


def mark_builder_codegen_job_succeeded(job_id: str, layout_spec_json: str) -> None:
    _write(
        """
        UPDATE builder_codegen_jobs
        SET status = 'succeeded', layout_spec_json = ?, finished_at = ?
        WHERE id = ?
        """,
        (layout_spec_json, now(), job_id),
    )


def mark_builder_codegen_job_failed(job_id: str, error_message: str) -> None:
    _write(
        """
        UPDATE builder_codegen_jobs
        SET status = 'failed_needs_human', error_message = ?, finished_at = ?
        WHERE id = ?
        """,
        (error_message, now(), job_id),
    )


def requeue_builder_codegen_job(job_id: str) -> None:
    """The admin 'retry' action — re-enters the queue with its attempt
    history intact (nothing here touches builder_codegen_attempts), so a
    fresh run's prior_feedback can still draw on what was already tried."""
    _write(
        """
        UPDATE builder_codegen_jobs
        SET status = 'queued', error_message = NULL, finished_at = NULL
        WHERE id = ?
        """,
        (job_id,),
    )


def approve_builder_codegen_job(job_id: str) -> dict | None:
    """The manual path to 'verified' (POST /admin/builder-codegen/{job_id}
    /approve) — still how every job short of the auto-verify fast path
    (mark_builder_codegen_job_auto_verified, migration 55) gets there. See
    backend/builder/codegen.py's module docstring for which jobs qualify for
    that fast path and which still land here."""
    job = get_builder_codegen_job(job_id)
    if not job or not job.get("layout_spec_json"):
        return None
    _write("UPDATE schools SET builder_status = 'verified' WHERE id = ?", (job["school_id"],))
    _write("UPDATE builder_codegen_jobs SET verified_at = ? WHERE id = ?", (now(), job_id))
    # See update_school_template_status's own comment — docx_build.builder()
    # caches per school_id and never re-checks builder_status on its own.
    from . import docx_build
    docx_build.builder.cache_clear()
    return get_school(job["school_id"])


def mark_builder_codegen_job_auto_verified(job_id: str) -> dict | None:
    """The auto-verify fast path (migration 55) — sets schools.builder_status
    = 'verified' the same as approve_builder_codegen_job, but only ever
    called from run_codegen_job itself, immediately after a job succeeds,
    and only when _meets_auto_verify_bar (codegen.py) says this job's own
    vision-judge pass is enough on its own — independent of whether the
    template's separate content review (template_status) has finished.
    auto_verified=true is what lets list_auto_verified_builder_jobs surface
    these separately from a job an admin actually clicked approve on."""
    job = get_builder_codegen_job(job_id)
    if not job or not job.get("layout_spec_json"):
        return None
    ts = now()
    _write("UPDATE schools SET builder_status = 'verified' WHERE id = ?", (job["school_id"],))
    _write(
        "UPDATE builder_codegen_jobs SET auto_verified = true, verified_at = ? WHERE id = ?",
        (ts, job_id),
    )
    # See update_school_template_status's own comment — docx_build.builder()
    # caches per school_id and never re-checks builder_status on its own.
    from . import docx_build
    docx_build.builder.cache_clear()
    return get_school(job["school_id"])


def list_auto_verified_builder_jobs(limit: int = 20) -> list[dict]:
    """The audit trail for the auto-verify fast path — mirrors
    list_auto_activated_templates' own "what did the pipeline decide on its
    own, after the fact" shape, one level further down the pipeline (a
    verified document BUILDER, not just an analyzed template format)."""
    return _rows(
        """
        SELECT j.*, s.name AS school_name, u.name AS uploader_name, u.email AS uploader_email
        FROM builder_codegen_jobs j
        JOIN schools s ON s.id = j.school_id
        LEFT JOIN school_templates st ON st.id = j.template_id
        LEFT JOIN users u ON u.id = st.uploaded_by
        WHERE j.auto_verified = true
        ORDER BY j.verified_at DESC
        LIMIT ?
        """,
        (limit,),
    )


def get_school_builder_spec(school_id: str) -> dict | None:
    """The winning layout spec for a school whose builder_status is
    'verified' — docx_build.builder() reads this directly rather than
    materializing a generated .py file on disk."""
    school = get_school(school_id)
    if not school or school.get("builder_status") != "verified":
        return None
    job = get_builder_codegen_job_for_school(school_id)
    if not job or not job.get("layout_spec_json"):
        return None
    return json.loads(job["layout_spec_json"])


def count_users_with_school(school_id: str) -> int:
    row = _row("SELECT COUNT(*) AS n FROM users WHERE school = ?", (school_id,))
    return int(row["n"]) if row else 0


def delete_school(school_id: str) -> bool:
    return _write("DELETE FROM schools WHERE id = ?", (school_id,)) > 0


def create_calendar_submission(
    school_id: str, submitted_by: str, source_kind: str, source_name: str | None, weeks: list[dict]
) -> dict:
    submission_id = new_id()
    _write(
        """
        INSERT INTO school_calendar_submissions
            (id, school_id, submitted_by, submitted_at, source_kind, source_name, weeks, status)
        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, 'pending')
        """,
        (submission_id, school_id, submitted_by, now(), source_kind, source_name, json.dumps(weeks)),
    )
    return get_calendar_submission(submission_id)  # type: ignore[return-value]


def get_calendar_submission(submission_id: str) -> dict | None:
    return _row("SELECT * FROM school_calendar_submissions WHERE id = ?", (submission_id,))


def confirmed_calendar_school_ids() -> set[str]:
    """Every school_id with at least one confirmed submission, in ONE query —
    see schoolcal.bulk_calendar_status's own comment for why GET /api/schools
    needs this instead of calling get_confirmed_calendar_submission per school
    (N+1 over ~300 seeded schools was slow enough to make that endpoint
    effectively hang). Only presence matters here, not which submission or
    when, so DISTINCT is enough — no ordering, no per-school LIMIT 1."""
    return {r["school_id"] for r in _rows("SELECT DISTINCT school_id FROM school_calendar_submissions WHERE status = 'confirmed'")}


def pending_calendar_school_ids() -> set[str]:
    """Same reasoning as confirmed_calendar_school_ids, for 'pending'."""
    return {r["school_id"] for r in _rows("SELECT DISTINCT school_id FROM school_calendar_submissions WHERE status = 'pending'")}


def get_pending_calendar_submission(school_id: str) -> dict | None:
    return _row(
        "SELECT * FROM school_calendar_submissions WHERE school_id = ? AND status = 'pending' ORDER BY submitted_at DESC LIMIT 1",
        (school_id,),
    )


def get_confirmed_calendar_submission(school_id: str) -> dict | None:
    return _row(
        "SELECT * FROM school_calendar_submissions WHERE school_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1",
        (school_id,),
    )


def confirm_calendar_submission(submission_id: str, confirmed_by: str) -> dict | None:
    """Caller (the route) must already have rejected confirmed_by == submitted_by
    — a submitter cannot be their own peer confirmation."""
    _write(
        "UPDATE school_calendar_submissions SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?",
        (confirmed_by, now(), submission_id),
    )
    return get_calendar_submission(submission_id)


def reject_calendar_submission(submission_id: str) -> dict | None:
    _write(
        "UPDATE school_calendar_submissions SET status = 'rejected' WHERE id = ?",
        (submission_id,),
    )
    return get_calendar_submission(submission_id)


def list_calendar_submissions(status: str | None = None) -> list[dict]:
    if status:
        return _rows(
            "SELECT * FROM school_calendar_submissions WHERE status = ? ORDER BY submitted_at DESC", (status,)
        )
    return _rows("SELECT * FROM school_calendar_submissions ORDER BY submitted_at DESC")


def get_user_school(user_id: str) -> str:
    """The calendar key for one teacher. Wraps get_user_by_id so every caller
    (week_board, generate's _with_week, llm.generate_plan/stream_plan,
    chat_stream) shares one fallback instead of each repeating it. The
    column itself is NOT NULL DEFAULT'd, so this only matters if user_id
    resolves to no row at all (an already-deleted account mid-request)."""
    user = get_user_by_id(user_id)
    return (user or {}).get("school") or "florence-high-school"


# ---------------------------------------------------------------------------
# Plans
# ---------------------------------------------------------------------------


def create_plan(
    *,
    plan_id: str,
    user_id: str,
    course: str,
    week_label: str,
    unit: str | None,
    query: str,
    plan_json: dict,
    docx_path: str | None,
    retrieved_ids: list[str],
    warnings: list[str],
    chat_id: str | None,
    template: str,
    class_id: str | None = None,
    week_number: int | None = None,
) -> dict:
    from .units import week_number as parse_week

    # Prefer the week the caller actually meant. Falling back to the label keeps
    # free-text generation working, but a caller that knows the week (the week
    # page does) must never have its answer overridden by what the model wrote.
    wk = week_number if week_number is not None else parse_week(week_label or "")

    _write(
        """INSERT INTO plans (id, user_id, created_at, course, week_label, unit, query, plan_json,
                              docx_path, retrieved_ids, warnings, chat_id, template, class_id,
                              week_number)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            plan_id,
            user_id,
            now(),
            course,
            week_label,
            unit,
            query,
            json.dumps(plan_json),
            docx_path,
            json.dumps(retrieved_ids),
            json.dumps(warnings),
            chat_id,
            template,
            class_id,
            wk,
        ),
    )
    return get_plan(user_id, plan_id)  # type: ignore[return-value]


def _hydrate_plan(row: dict) -> dict:
    d = dict(row)
    d["plan_json"] = json.loads(d["plan_json"]) if d.get("plan_json") else None
    d["retrieved_ids"] = json.loads(d["retrieved_ids"]) if d.get("retrieved_ids") else []
    d["warnings"] = json.loads(d["warnings"]) if d.get("warnings") else []
    d["has_docx"] = bool(d.get("docx_path")) and Path(d["docx_path"]).is_file()
    return d


_PLAN_LIST_COLUMNS = "id, created_at, course, week_label, unit, query, docx_path, retrieved_ids, warnings, chat_id, template, user_id, class_id, week_number, drive_file_id, drive_web_link, is_public, shared_at"


def _hydrate_plan_list(row: dict) -> dict:
    """Hydrate list metadata without transferring the full plan JSON."""
    d = dict(row)
    d["retrieved_ids"] = json.loads(d["retrieved_ids"]) if d.get("retrieved_ids") else []
    d["warnings"] = json.loads(d["warnings"]) if d.get("warnings") else []
    d["has_docx"] = bool(d.get("docx_path")) and Path(d["docx_path"]).is_file()
    return d


def get_plan(user_id: str, plan_id: str) -> dict | None:
    row = _row("SELECT * FROM plans WHERE id = ? AND user_id = ?", (plan_id, user_id))
    return _hydrate_plan(row) if row else None


def get_public_plan(plan_id: str) -> dict | None:
    """A plan the owner has deliberately published, or None.

    `AND is_public` is the whole point (migration 39). Without it this was
    "SELECT * FROM plans WHERE id = ?" behind an endpoint that takes no auth,
    which made every plan in the database readable by anyone holding its id —
    confirmed live with no cookie: HTTP 200, full plan body, never shared.

    Not scoped to a user_id, deliberately: the caller here is by definition not
    the owner. The share model is a capability URL (the same one Google Docs's
    "anyone with the link" uses) and `is_public` is the capability being
    granted. Revoking it (set_plan_public with False) makes every copy of the
    link dead immediately.
    """
    row = _row("SELECT * FROM plans WHERE id = ? AND is_public", (plan_id,))
    return _hydrate_plan(row) if row else None


def set_plan_public(user_id: str, plan_id: str, public: bool) -> dict | None:
    """Publish or unpublish one of the caller's OWN plans.

    Scoped to user_id, unlike the read above — publishing someone else's plan
    has to be impossible even if the id is known.
    """
    _write(
        "UPDATE plans SET is_public = ?, shared_at = ? WHERE id = ? AND user_id = ?",
        (bool(public), now() if public else None, plan_id, user_id),
    )
    return _row("SELECT id, is_public, shared_at FROM plans WHERE id = ? AND user_id = ?", (plan_id, user_id))


def get_plan_count(user_id: str) -> int:
    row = _row("SELECT COUNT(*) AS count FROM plans WHERE user_id = ?", (user_id,))
    return row["count"] if row else 0


def list_plans(
    user_id: str,
    *,
    limit: int = 50,
    offset: int = 0,
    q: str | None = None,
    class_id: str | None = None,
    chat_id: str | None = None,
) -> dict:
    where, params = "WHERE user_id = ?", [user_id]
    if class_id:
        where += " AND class_id = ?"
        params.append(class_id)
    if chat_id:
        where += " AND chat_id = ?"
        params.append(chat_id)
    if q:
        where += " AND (week_label LIKE ? OR query LIKE ? OR unit LIKE ?)"
        like = f"%{q}%"
        params += [like, like, like]

    total = _row(f"SELECT COUNT(*) AS n FROM plans {where}", tuple(params))["n"]  # type: ignore[index]
    rows = _rows(
        f"SELECT {_PLAN_LIST_COLUMNS} FROM plans {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        tuple(params + [limit, offset]),
    )
    items = [_hydrate_plan_list(r) for r in rows]
    return {"items": items, "total": total}


def list_plan_weeks(user_id: str, class_id: str) -> dict:
    """The Library, grouped by calendar week instead of raw generation history.

    `list_plans` returns one row per `plans` row with no dedup, so
    regenerating a week (rather than revising the existing one) just adds
    another row — the same week then appears twice in a flat, newest-first
    list. This groups those rows by week_number, keeping the newest as
    `latest` and collapsing the rest into `revisions`.

    Ordered `created_at DESC` before grouping (unlike week_board's own
    by-week dict, which has no ORDER BY and so keeps whichever row SQLite
    happens to return first) — so the first row seen for a given week here is
    reliably the most recent one.

    A plan whose week can't be resolved at all (no week_number column, and
    week_label doesn't parse) still gets shown, as its own single-plan
    "week" — silently dropping it from the Library would be worse than an
    ungrouped card."""
    from .units import week_number

    rows = _rows(
        f"SELECT {_PLAN_LIST_COLUMNS} FROM plans WHERE user_id = ? AND class_id = ? ORDER BY created_at DESC",
        (user_id, class_id),
    )

    by_week: dict[int, dict] = {}
    loose: list[dict] = []
    for r in rows:
        p = _hydrate_plan_list(r)
        n = p.get("week_number") or week_number(p.get("week_label") or "")
        if n is None:
            loose.append(p)
            continue
        if n not in by_week:
            by_week[n] = {
                "week_number": n,
                "week_label": p.get("week_label"),
                "unit": p.get("unit"),
                "latest": p,
                "revisions": [],
            }
        else:
            by_week[n]["revisions"].append(p)

    weeks = [by_week[n] for n in sorted(by_week)]
    weeks += [
        {"week_number": None, "week_label": p.get("week_label"), "unit": p.get("unit"), "latest": p, "revisions": []}
        for p in loose
    ]
    return {"weeks": weeks}


def update_plan(user_id: str, plan_id: str, **fields: Any) -> dict | None:
    allowed = {"plan_json", "week_label", "unit", "docx_path", "warnings", "course", "class_id", "template"}
    sets, params = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        sets.append(f"{k} = ?")
        params.append(json.dumps(v) if k in ("plan_json", "warnings") else v)
    if sets:
        params += [plan_id, user_id]
        _write(f"UPDATE plans SET {', '.join(sets)} WHERE id = ? AND user_id = ?", tuple(params))
        # Every async rebuild clears docx_path before returning. Queue its
        # durable replacement in the same request instead of trusting a
        # FastAPI in-process background task to survive a restart.
        if fields.get("docx_path", object()) is None:
            enqueue_document_build(plan_id, user_id)
    return get_plan(user_id, plan_id)


def enqueue_document_build(plan_id: str, user_id: str) -> dict:
    """Queue (or re-queue) a DOCX build after its plan transaction commits."""
    stamp = now()
    _write(
        """
        INSERT INTO document_build_jobs (plan_id, user_id, status, attempts, error_message, created_at, updated_at, available_at)
        VALUES (?, ?, 'queued', 0, NULL, ?, ?, ?)
        ON CONFLICT (plan_id) DO UPDATE SET
          status = 'queued', attempts = 0, error_message = NULL,
          updated_at = EXCLUDED.updated_at, available_at = EXCLUDED.available_at
        """,
        (plan_id, user_id, stamp, stamp, stamp),
    )
    return get_document_build_status(plan_id, user_id) or {}


def get_document_build_status(plan_id: str, user_id: str) -> dict | None:
    return _row(
        "SELECT plan_id, status, attempts, error_message, updated_at, available_at FROM document_build_jobs WHERE plan_id = ? AND user_id = ?",
        (plan_id, user_id),
    )


def claim_next_document_build() -> dict | None:
    return _row(
        """
        UPDATE document_build_jobs SET status = 'building', attempts = attempts + 1, updated_at = ?
        WHERE plan_id = (
          SELECT plan_id FROM document_build_jobs
          WHERE status = 'queued' AND COALESCE(available_at, updated_at) <= ?
          ORDER BY COALESCE(available_at, updated_at) FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING *
        """,
        (now(), now()),
    )


def finish_document_build(plan_id: str, user_id: str, *, error_message: str | None = None) -> None:
    if error_message:
        job = get_document_build_status(plan_id, user_id) or {}
        attempts = int(job.get("attempts") or 0)
        # A restart, transient storage failure, or short-lived LibreOffice
        # issue should not require a teacher to notice and click Rebuild. Keep
        # retries bounded so a persistently malformed document reaches a clear
        # failed state for recovery instead of looping forever.
        if attempts < 3:
            delay_seconds = 15 * (2 ** max(0, attempts - 1))
            available_at = (datetime.now(UTC) + timedelta(seconds=delay_seconds)).isoformat(timespec="seconds")
            _write(
                """
                UPDATE document_build_jobs
                SET status = 'queued', error_message = ?, updated_at = ?, available_at = ?
                WHERE plan_id = ? AND user_id = ?
                """,
                (error_message, now(), available_at, plan_id, user_id),
            )
            return
    _write(
        "UPDATE document_build_jobs SET status = ?, error_message = ?, updated_at = ?, available_at = ? WHERE plan_id = ? AND user_id = ?",
        ('failed' if error_message else 'ready', error_message, now(), now(), plan_id, user_id),
    )


def reset_stale_document_builds(stale_after_seconds: int = 900) -> int:
    threshold = (datetime.now(UTC) - timedelta(seconds=stale_after_seconds)).isoformat(timespec='seconds')
    return _write(
        "UPDATE document_build_jobs SET status = 'queued', updated_at = ?, available_at = ? WHERE status = 'building' AND updated_at < ?",
        (now(), now(), threshold),
    )


def list_plans_for_school_template_repair(school_id: str, stale_template: str) -> list[dict]:
    """Plans whose stored document was built with an obsolete school form.

    Kept deliberately narrow and idempotent: after a successful rebuild each
    row receives its new template id, so later deployments do no extra work.
    """
    rows = _rows(
        """
        SELECT p.* FROM plans p
        JOIN classes c ON c.id = p.class_id
        WHERE c.school = ? AND p.template = ?
        ORDER BY p.created_at
        """,
        (school_id, stale_template),
    )
    return [_hydrate_plan(row) for row in rows]


def list_plans_for_school(school_id: str) -> list[dict]:
    """All plans attached to one school's classes.

    Kept separate from the template-id migration query above: a plan can use
    the correct builder and still predate fields that builder visibly requires.
    The service decides which rows actually need repair after reading their
    normalized JSON, avoiding database-specific JSON predicates.
    """
    rows = _rows(
        """
        SELECT p.* FROM plans p
        JOIN classes c ON c.id = p.class_id
        WHERE c.school = ?
        ORDER BY p.created_at
        """,
        (school_id,),
    )
    return [_hydrate_plan(row) for row in rows]


def delete_plan(user_id: str, plan_id: str) -> bool:
    return _write("DELETE FROM plans WHERE id = ? AND user_id = ?", (plan_id, user_id)) > 0


def set_plan_drive_file(user_id: str, plan_id: str, *, file_id: str, web_link: str) -> None:
    """Recorded once, the first time a plan is shared — every share after
    that reuses this same Doc rather than routes/drive.py minting a new one
    on every click of Share."""
    _write(
        "UPDATE plans SET drive_file_id = ?, drive_web_link = ? WHERE id = ? AND user_id = ?",
        (file_id, web_link, plan_id, user_id),
    )


def add_plan_share(plan_id: str, *, email: str, role: str) -> dict:
    share_id = uuid.uuid4().hex
    _write(
        "INSERT INTO plan_shares (id, plan_id, email, role, created_at) VALUES (?,?,?,?,?)",
        (share_id, plan_id, email, role, now()),
    )
    return _row("SELECT * FROM plan_shares WHERE id = ?", (share_id,))  # type: ignore[return-value]


def list_plan_shares(plan_id: str) -> list[dict]:
    return _rows(
        "SELECT * FROM plan_shares WHERE plan_id = ? ORDER BY created_at DESC", (plan_id,)
    )


def replace_plan_standards(
    plan_id: str,
    user_id: str,
    *,
    class_id: str | None,
    subject: str | None,
    grade: str | None,
    entries: list[dict],
) -> None:
    """Swap in one plan's full cited-standards snapshot (migration 29).
    `entries` is retrieval.cited_standards()'s own output. Deletes the
    plan's existing rows first — same shape as replace_curriculum_chunks
    below — so a revision that drops a code doesn't leave a stale row
    behind still claiming the current plan cites it."""
    from psycopg2.extras import execute_values

    _write("DELETE FROM plan_standards WHERE plan_id = ?", (plan_id,))
    if not entries:
        return
    ts = now()
    with borrow() as conn:
        with conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO plan_standards
                    (plan_id, user_id, class_id, subject, grade, day_index, day_name, field, code, status, created_at)
                VALUES %s
                """,
                [
                    (
                        plan_id,
                        user_id,
                        class_id,
                        subject,
                        grade,
                        e["day_index"],
                        e["day_name"],
                        e["field"],
                        e["code"],
                        e["status"],
                        ts,
                    )
                    for e in entries
                ],
            )
        conn.commit()


def add_plan_feedback(user_id: str, plan_id: str, is_good: bool, notes: str | None = None) -> bool:
    # Ensure plan belongs to user
    if not get_plan(user_id, plan_id):
        return False
    
    _write(
        "INSERT INTO plan_feedback (user_id, plan_id, is_good, notes, created_at) VALUES (?, ?, ?, ?, ?)",
        (user_id, plan_id, 1 if is_good else 0, notes, now())
    )
    return True


# ---------------------------------------------------------------------------
# Quizzes — a plan can have several (migration 26)
# ---------------------------------------------------------------------------


def _hydrate_quiz(row: dict) -> dict:
    d = dict(row)
    d["question_types"] = json.loads(d["question_types"]) if d.get("question_types") else []
    d["quiz_json"] = json.loads(d["quiz_json"]) if d.get("quiz_json") else None
    d["warnings"] = json.loads(d["warnings"]) if d.get("warnings") else []
    # Same shape as plans' own has_docx — a row can outlive its file (a
    # crashed build_qti_zip, or the file cleaned up outside the app), and
    # the download route needs to say so rather than 500 on a missing path.
    #
    # On a host with an ephemeral disk (Render's free plan — see render.yaml),
    # every restart wipes plans_dir, so a plain is_file() check would gray
    # out the download button for every quiz built before the last restart
    # even though storage.mirror_file() backed it up. Try to self-heal from
    # durable storage here (the same call download_quiz already makes)
    # rather than only offering to restore it once the user clicks Download.
    qti_path = d.get("qti_path")
    d["has_qti"] = bool(qti_path) and storage.ensure_local(Path(qti_path))
    return d


def create_quiz(
    *,
    quiz_id: str,
    user_id: str,
    plan_id: str,
    title: str,
    question_types: list[str],
    quiz_json: dict,
    qti_path: str | None,
    warnings: list[str],
) -> dict:
    _write(
        """INSERT INTO quizzes (id, user_id, plan_id, title, question_types, quiz_json,
                                qti_path, warnings, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            quiz_id,
            user_id,
            plan_id,
            title,
            json.dumps(question_types),
            json.dumps(quiz_json),
            qti_path,
            json.dumps(warnings),
            now(),
        ),
    )
    return get_quiz(user_id, quiz_id)  # type: ignore[return-value]


def get_quiz(user_id: str, quiz_id: str) -> dict | None:
    row = _row("SELECT * FROM quizzes WHERE id = ? AND user_id = ?", (quiz_id, user_id))
    return _hydrate_quiz(row) if row else None


def update_quiz(
    user_id: str, quiz_id: str, quiz_json: dict, qti_path: str | None, warnings: list[str] | None = None
) -> dict | None:
    # warnings stays untouched (None) for the manual-edit PUT route, which
    # re-validates in place and has no fresh warnings to report; the
    # chat-driven revise route (routes/plans.py) always re-runs schema
    # validation and passes its own list, even an empty one.
    if warnings is None:
        _write(
            "UPDATE quizzes SET quiz_json = ?, qti_path = ? WHERE id = ? AND user_id = ?",
            (json.dumps(quiz_json), qti_path, quiz_id, user_id),
        )
    else:
        _write(
            "UPDATE quizzes SET quiz_json = ?, qti_path = ?, warnings = ? WHERE id = ? AND user_id = ?",
            (json.dumps(quiz_json), qti_path, json.dumps(warnings), quiz_id, user_id),
        )
    return get_quiz(user_id, quiz_id)


def list_quizzes_for_plan(user_id: str, plan_id: str) -> list[dict]:
    rows = _rows(
        "SELECT * FROM quizzes WHERE plan_id = ? AND user_id = ? ORDER BY created_at DESC",
        (plan_id, user_id),
    )
    return [_hydrate_quiz(r) for r in rows]


def delete_quiz(user_id: str, quiz_id: str) -> bool:
    return _write("DELETE FROM quizzes WHERE id = ? AND user_id = ?", (quiz_id, user_id)) > 0


# ---------------------------------------------------------------------------
# Curriculum maps & progress
#
# One active map per subject. Replacing means: insert the new row, deactivate
# the old one — the old row (and its file on disk) is left alone until the
# teacher explicitly deletes it, so "replace" is never silent data loss.
# ---------------------------------------------------------------------------


def create_curriculum_map(*, map_id: str, user_id: str, subject: str, original_name: str, stored_path: str, chars: int) -> dict:
    _write(
        "UPDATE curriculum_maps SET active = 0 WHERE user_id = ? AND subject = ? AND active = 1",
        (user_id, subject),
    )
    _write(
        """INSERT INTO curriculum_maps (id, user_id, subject, original_name, stored_path, chars, active, uploaded_at)
           VALUES (?,?,?,?,?,?,1,?)""",
        (map_id, user_id, subject, original_name, stored_path, chars, now()),
    )
    return get_curriculum_map(user_id, map_id)  # type: ignore[return-value]


def get_curriculum_map(user_id: str, map_id: str) -> dict | None:
    row = _row("SELECT * FROM curriculum_maps WHERE id = ? AND user_id = ?", (map_id, user_id))
    return dict(row) if row else None


def get_active_curriculum_map(user_id: str, subject: str) -> dict | None:
    row = _row(
        "SELECT * FROM curriculum_maps WHERE user_id = ? AND subject = ? AND active = 1 ORDER BY uploaded_at DESC LIMIT 1",
        (user_id, subject),
    )
    return dict(row) if row else None


def delete_curriculum_map(user_id: str, map_id: str) -> dict | None:
    """Deletes the DB row (and, via ON DELETE CASCADE, its progress rows).

    Does NOT touch the file on disk or the Chroma chunks — callers handle those,
    since this module has no business doing filesystem/vector-store I/O.
    """
    row = get_curriculum_map(user_id, map_id)
    if row:
        _write("DELETE FROM curriculum_maps WHERE id = ? AND user_id = ?", (map_id, user_id))
    return row


def replace_curriculum_progress(user_id: str, map_id: str, subject: str, rows: list[dict]) -> None:
    _write("DELETE FROM curriculum_progress WHERE map_id = ? AND user_id = ?", (map_id, user_id))
    for i, r in enumerate(rows):
        _write(
            """INSERT INTO curriculum_progress
               (id, user_id, map_id, subject, sort_order, unit, week_label, target_start, target_end, standards, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                new_id(),
                user_id,
                map_id,
                subject,
                i,
                r.get("unit"),
                r.get("week_label"),
                r.get("target_start"),
                r.get("target_end"),
                json.dumps(r.get("standards") or []),
                r.get("notes"),
            ),
        )


def list_curriculum_progress(user_id: str, subject: str) -> list[dict]:
    active = get_active_curriculum_map(user_id, subject)
    if not active:
        return []
    rows = _rows(
        "SELECT * FROM curriculum_progress WHERE map_id = ? AND user_id = ? ORDER BY sort_order",
        (active["id"], user_id),
    )
    out = []
    for r in rows:
        d = dict(r)
        d["standards"] = json.loads(d["standards"]) if d.get("standards") else []
        out.append(d)
    return out


def _iso_date(value: str | None) -> str | None:
    """Only ever accepts what curriculum.parse_curriculum_progress was told to
    write: a bare YYYY-MM-DD. Anything else (a range, a bare month, a typo) is
    treated as "no date" rather than guessed at — a wrong guess would make the
    pace indicator actively misleading, which is worse than showing none."""
    if not value or len(value) != 10:
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")  # noqa: DTZ007 — format check only, the parsed value is discarded
        return value
    except ValueError:
        return None


def _week_status(target_start: str | None, target_end: str | None, today: str) -> str:
    start, end = _iso_date(target_start), _iso_date(target_end)
    if end and end < today:
        return "behind"
    if start and start > today:
        return "upcoming"
    if start or end:
        return "current"
    return "unscheduled"


def curriculum_status(user_id: str, subject: str) -> dict:
    """The progress schedule plus a pace read against actual generated plans.

    A week counts as covered if a plan exists whose week_label carries the same
    week number — not by date alone, since a date-only view would call every
    past-due week "behind" even for weeks a teacher has already taught and
    planned. Matched by week number (via units.week_number, the same parse the
    plans library already uses) rather than a subject foreign key, because
    `plans` has none; scoped to this teacher's own course display name (and to
    their own plans) to avoid crediting a different teacher's or subject's plan
    for the same week number.
    """
    from . import units

    active = get_active_curriculum_map(user_id, subject)
    progress = list_curriculum_progress(user_id, subject)
    if not active or not progress:
        return {"map": None, "weeks": [], "summary": None}

    course = get_settings_row(user_id, subject).get("course")
    covered = {
        n
        for r in _rows("SELECT week_label FROM plans WHERE course = ? AND user_id = ?", (course, user_id))
        for n in [units.week_number(r["week_label"])]
        if n is not None
    }

    today = now()[:10]
    weeks = []
    for row in progress:
        wn = units.week_number(row.get("week_label") or "")
        has_plan = wn is not None and wn in covered
        status = "done" if has_plan else _week_status(row.get("target_start"), row.get("target_end"), today)
        weeks.append({**row, "week_number": wn, "has_plan": has_plan, "status": status})

    behind = [w for w in weeks if w["status"] == "behind"]
    current = next((w for w in weeks if w["status"] == "current"), None)
    return {
        "map": {
            "id": active["id"],
            "original_name": active["original_name"],
            "uploaded_at": active["uploaded_at"],
        },
        "weeks": weeks,
        "summary": {
            "total": len(weeks),
            "done": sum(1 for w in weeks if w["status"] == "done"),
            "behind": len(behind),
            "current_week_label": current["week_label"] if current else None,
            "on_pace": not behind,
        },
    }


# ---------------------------------------------------------------------------
# Class documents
#
# curriculum_maps, scoped to a class instead of a framework and allowed to hold
# more than one kind of thing. A teacher has a pacing guide AND a syllabus AND
# sometimes a curriculum map; the old table could hold exactly one per subject,
# so uploading the second silently deactivated the first.
# ---------------------------------------------------------------------------

DOCUMENT_KINDS = ("pacing_guide", "syllabus", "curriculum_map", "other")


def list_class_documents(user_id: str, class_id: str) -> list[dict]:
    return _rows(
        """SELECT id, class_id, subject, kind, original_name, chars, active, uploaded_at
             FROM curriculum_maps
            WHERE user_id = ? AND class_id = ? AND active = 1
            ORDER BY uploaded_at DESC""",
        (user_id, class_id),
    )


def create_class_document(
    *, map_id: str, user_id: str, class_id: str, subject: str, kind: str,
    original_name: str, stored_path: str, chars: int,
) -> dict:
    if kind not in DOCUMENT_KINDS:
        kind = "other"
    _write(
        """INSERT INTO curriculum_maps
             (id, user_id, class_id, subject, kind, original_name, stored_path, chars, active, uploaded_at)
           VALUES (?,?,?,?,?,?,?,?,1,?)""",
        (map_id, user_id, class_id, subject, kind, original_name, stored_path, chars, now()),
    )
    return _row("SELECT * FROM curriculum_maps WHERE id = ?", (map_id,))  # type: ignore[return-value]


def list_global_documents(user_id: str) -> list[dict]:
    return _rows(
        """SELECT id, class_id, subject, kind, original_name, chars, active, uploaded_at
             FROM curriculum_maps
            WHERE user_id = ? AND class_id IS NULL AND subject = 'GLOBAL' AND active = 1
            ORDER BY uploaded_at DESC""",
        (user_id,),
    )


def create_global_document(
    *, map_id: str, user_id: str, kind: str,
    original_name: str, stored_path: str, chars: int,
) -> dict:
    if kind not in DOCUMENT_KINDS:
        kind = "other"
    _write(
        """INSERT INTO curriculum_maps
             (id, user_id, class_id, subject, kind, original_name, stored_path, chars, active, uploaded_at)
           VALUES (?,?,NULL,'GLOBAL',?,?,?,?,1,?)""",
        (map_id, user_id, kind, original_name, stored_path, chars, now()),
    )
    return _row("SELECT * FROM curriculum_maps WHERE id = ?", (map_id,))  # type: ignore[return-value]


def get_class_document(user_id: str, class_id: str, kind: str) -> dict | None:
    return _row(
        """SELECT * FROM curriculum_maps
            WHERE user_id = ? AND class_id = ? AND kind = ? AND active = 1
            ORDER BY uploaded_at DESC LIMIT 1""",
        (user_id, class_id, kind),
    )


# ---------------------------------------------------------------------------
# Curriculum map chunks (pgvector)
# ---------------------------------------------------------------------------


def replace_curriculum_chunks(map_id: str, user_id: str, rows: list) -> int:
    """Swap in one map's chunks. `rows` is [(document, embedding), ...]."""
    from psycopg2.extras import execute_values

    _write("DELETE FROM curriculum_chunks WHERE map_id = ?", (map_id,))
    if not rows:
        return 0
    with borrow() as conn:
        with conn.cursor() as cur:
            execute_values(
                cur,
                "INSERT INTO curriculum_chunks (id, map_id, user_id, chunk_index, document, embedding) VALUES %s",
                [(f"{map_id}:{i}", map_id, user_id, i, doc, emb) for i, (doc, emb) in enumerate(rows)],
            )
        conn.commit()
    return len(rows)


def delete_curriculum_chunks(map_id: str) -> None:
    _write("DELETE FROM curriculum_chunks WHERE map_id = ?", (map_id,))


def search_curriculum_chunks(map_id: str, query_vec: list, top_k: int = 4) -> list:
    """Nearest chunks within ONE map.

    Scoped by map_id, never by subject: two teachers sharing a subject name must
    not read each other's pacing guide, and a superseded upload's chunks must not
    resurface (replacing a map deactivates its row but the chunks would linger)."""
    rows = _rows(
        """SELECT document FROM curriculum_chunks
            WHERE map_id = %s
            ORDER BY embedding <=> %s::vector
            LIMIT %s""",
        (map_id, query_vec, top_k),
    )
    return [r["document"] for r in rows]


# ---------------------------------------------------------------------------
# The week board
# ---------------------------------------------------------------------------


def week_board(user_id: str, class_id: str | None = None, *, around: int = 0) -> dict:
    """The school year for one class: every week, whether it has a plan, and
    what the calendar says about it.

    Replaces guessing. The starter prompts used to compute "next Monday" in the
    browser with no idea whether that week was Fall Break, and week_label was
    whatever the model decided to write. Both now come from the same file the
    prompt quotes — the teacher's own school's calendar under
    backend/context/calendars/ — so a week the school is closed can be shown as
    closed rather than offered as a plan to build."""
    from . import schoolcal  # local: keeps the calendar out of db's import cycle

    cls = resolve_class(user_id, class_id)
    # class_school, not get_user_school directly — a class pinned to a
    # different school than the account default (migration 25) shows ITS
    # calendar, not whichever one the account happens to default to.
    school_id = class_school(cls, user_id)
    weeks = schoolcal.school_weeks(school_id)
    # Named, and returned even when the calendar comes back empty. Every
    # week this board produces belongs to ONE school's calendar, and until
    # now the payload said only "weeks" — leaving the UI to present a
    # district's real closures and teaching days as though they came from
    # nowhere, with no way to attribute them or to say WHOSE calendar is
    # missing when there isn't one. Falls back to the raw id if the schools
    # row is gone, since a name is presentation and the id is the truth.
    school_row = get_school(school_id)
    school = {
        "id": school_id,
        "name": (school_row or {}).get("name") or school_id,
        "has_calendar": bool(weeks),
    }
    if not weeks:
        return {"class": cls, "school": school, "weeks": [], "current_week": None}

    # Which weeks already have a plan. class_id is the key where one exists;
    # plans written before migration 9 only have the course display name, so
    # both are accepted rather than showing a teacher's own back-catalogue as
    # unplanned.
    if cls:
        rows = _rows(
            "SELECT week_label, week_number, id, unit, class_id, course, chat_id FROM plans WHERE user_id = ? AND (class_id = ? OR (class_id IS NULL AND course = ?))",
            (user_id, cls["id"], cls["name"]),
        )
    else:
        rows = _rows("SELECT week_label, week_number, id, unit, class_id, course, chat_id FROM plans WHERE user_id = ?", (user_id,))

    from .units import week_number

    by_week: dict[int, dict] = {}
    for r in rows:
        # The stored column is the week the teacher asked for; the label parse is
        # only a fallback for rows written before migration 11 whose backfill
        # found nothing.
        n = r.get("week_number") or week_number(r["week_label"] or "")
        if n is not None:
            by_week.setdefault(
                n, {"plan_id": r["id"], "week_label": r["week_label"], "unit": r.get("unit"), "chat_id": r.get("chat_id")}
            )

    today = now()[:10]
    current = schoolcal.week_for(school_id)
    out = []
    for w in weeks:
        plan = by_week.get(w["week"])
        days = schoolcal.week_days(school_id, w)
        out.append(
            {
                **w,
                "label": schoolcal.label_for(w),
                # Mon–Fri with a date and a reason on each. The board can shade a
                # holiday in the cell it actually falls in; the week row alone
                # could only say "something in here is closed".
                "days": days,
                "teaching_days": sum(1 for d in days if d["is_school"]),
                "plan_id": (plan or {}).get("plan_id"),
                # The chat that produced (or last revised) this week's plan —
                # so a built week can be opened straight into its own
                # conversation instead of only being known to exist.
                "chat_id": (plan or {}).get("chat_id"),
                # What the week is ABOUT. The board shows this instead of
                # repeating the date that is already in the row's date column.
                "unit": (plan or {}).get("unit"),
                "has_plan": plan is not None,
                "is_current": bool(current and current["week"] == w["week"]),
                # w["end"] is None for a week with no real calendar dates
                # (schoolcal.NO_CALENDAR_SCHOOL_ID) — there's no "today" to
                # compare against a schedule that isn't real yet, so such a
                # week is never past, only ever upcoming until it's built.
                "is_past": bool(w["end"]) and w["end"] < today,
            }
        )

    return {
        "class": cls,
        "school": school,
        "weeks": out,
        "current_week": current["week"] if current else None,
    }


# ---------------------------------------------------------------------------
# Chats & messages
# ---------------------------------------------------------------------------


def create_chat(
    user_id: str,
    title: str,
    chat_id: str | None = None,
    class_id: str | None = None,
    week_number: int | None = None,
    mode: str | None = None,
) -> dict:
    """`class_id` is what keeps one prep's conversations out of another's
    sidebar. It was never passed, so every chat was written NULL — see the
    backfill in migration 14.

    `week_number` is the week this conversation is about, pinned once here so
    it cannot drift out from under the chat — see migration 24 for what
    deriving it per-render cost."""
    cid = chat_id or new_id()
    ts = now()
    _write(
        "INSERT INTO chats (id, user_id, title, class_id, week_number, mode, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
        (cid, user_id, title[:200], class_id, week_number, mode, ts, ts),
    )
    return get_chat(user_id, cid)  # type: ignore[return-value]


def get_chat(user_id: str, chat_id: str, with_messages: bool = False) -> dict | None:
    row = _row("SELECT * FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id))
    if not row:
        return None
    chat = dict(row)
    if with_messages:
        chat["messages"] = list_messages(chat_id)
    return chat


def list_chats(user_id: str, limit: int = 100, class_id: str | None = None) -> list[dict]:
    """Scoped to one prep when asked.

    `class_id IS NULL` rows are included deliberately: they are the chats that
    predate scoping and could not be attributed from their plans, and hiding a
    teacher's own history to tidy a list is the wrong trade. They surface in
    every class, which is what they did before."""
    where, params = "WHERE user_id = ?", [user_id]
    if class_id:
        where += " AND (class_id = ? OR class_id IS NULL)"
        params.append(class_id)
    return [
        dict(r)
        for r in _rows(
            f"SELECT * FROM chats {where} ORDER BY updated_at DESC LIMIT ?", tuple(params + [limit])
        )
    ]


def toggle_chat_pin(user_id: str, chat_id: str, is_pinned: bool) -> dict | None:
    _write(
        "UPDATE chats SET is_pinned = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (int(is_pinned), now(), chat_id, user_id),
    )
    return get_chat(user_id, chat_id)

def rename_chat(user_id: str, chat_id: str, title: str) -> dict | None:
    _write(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (title[:200], now(), chat_id, user_id),
    )
    return get_chat(user_id, chat_id)


def set_chat_week(user_id: str, chat_id: str, week_number: int) -> dict | None:
    """Re-pin which week an existing conversation is about.

    Its own function rather than a field on rename_chat's UPDATE: the two are
    unrelated edits arriving from unrelated controls, and PATCH /chats/{id}
    requires a title it would have no business sending just to move a week.

    Deliberately does NOT touch updated_at — that column orders the sidebar,
    and correcting which week a chat was always about is not the chat being
    used, so it shouldn't jump the list."""
    _write(
        "UPDATE chats SET week_number = ? WHERE id = ? AND user_id = ?",
        (week_number, chat_id, user_id),
    )
    return get_chat(user_id, chat_id)


def delete_chat(user_id: str, chat_id: str) -> bool:
    return _write("DELETE FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id)) > 0


def add_message(
    chat_id: str,
    role: str,
    content: str,
    plan_id: str | None = None,
    client_id: str | None = None,
    source: str | None = None,
) -> dict:
    """Not user-scoped: callers must already have verified (via get_chat) that
    this chat belongs to the requesting user. Messages have no user_id column
    of their own — ownership lives entirely on the parent chat.

    `source` is NULL for ordinary typed messages, 'voice' for one whose
    content came from Voice Mode's speech-to-text (see ChatPage.jsx's
    submit(), which sets it from options.voiceTurn) — a spoken aside is
    plausibly less edited/considered than something a teacher typed and
    reread, so this exists to let retention or export policy treat the two
    differently later, without having to guess after the fact."""
    with borrow() as conn:
        with conn.cursor() as cur:
            if client_id:
                cur.execute(
                    """
                    INSERT INTO messages (chat_id, role, content, plan_id, client_id, source, created_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (chat_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
                    RETURNING id, chat_id, role, content, plan_id, client_id, source, created_at
                    """,
                    (chat_id, role, content, plan_id, client_id[:128], source, now()),
                )
                row = cur.fetchone()
                if row is None:
                    cur.execute(
                        "SELECT id, chat_id, role, content, plan_id, client_id, source, created_at FROM messages WHERE chat_id = %s AND client_id = %s",
                        (chat_id, client_id[:128]),
                    )
                    row = cur.fetchone()
            else:
                cur.execute(
                    """
                    INSERT INTO messages (chat_id, role, content, plan_id, source, created_at)
                    VALUES (%s,%s,%s,%s,%s,%s)
                    RETURNING id, chat_id, role, content, plan_id, client_id, source, created_at
                    """,
                    (chat_id, role, content, plan_id, source, now()),
                )
                row = cur.fetchone()
            cur.execute("UPDATE chats SET updated_at = %s WHERE id = %s", (now(), chat_id))
        conn.commit()
    return dict(row)


def list_messages(chat_id: str) -> list[dict]:
    """Not user-scoped — see add_message's note."""
    return [
        dict(r)
        for r in _rows("SELECT * FROM messages WHERE chat_id = ? ORDER BY id", (chat_id,))
    ]


def import_chats(user_id: str, payload: list[dict]) -> dict:
    """Idempotent import of the old localStorage['lesson_chats'] array.

    The frontend clears localStorage only after this returns 200, so a failed
    import is never data loss.
    """
    imported = skipped = 0
    for chat in payload:
        cid = str(chat.get("id") or new_id())
        if _row("SELECT id FROM chats WHERE id = ?", (cid,)):
            skipped += 1
            continue
        create_chat(user_id, str(chat.get("title") or "Imported chat"), chat_id=cid)
        for msg in chat.get("messages") or []:
            role = msg.get("role")
            if role not in ("user", "assistant", "system"):
                continue
            add_message(cid, role, str(msg.get("content") or ""))
        imported += 1
    return {"imported": imported, "skipped": skipped}


# ---------------------------------------------------------------------------
# Users (accounts)
# ---------------------------------------------------------------------------


def get_user_by_email(email: str) -> dict | None:
    row = _row("SELECT * FROM users WHERE email = ?", (email.strip().lower(),))
    return dict(row) if row else None


def get_user_by_id(user_id: str) -> dict | None:
    row = _row("SELECT * FROM users WHERE id = ?", (user_id,))
    return dict(row) if row else None


def bump_session_version(user_id: str) -> int:
    """Sign out of every device at once, for this one account. See migration
    18: every session token carries the version it was issued under, and
    deps.get_current_user rejects any token whose version doesn't match this
    column's CURRENT value — so incrementing it here is the entire mechanism,
    no sessions table to also clear. Returns the new value, mostly so a test
    can assert it moved."""
    _write("UPDATE users SET session_version = session_version + 1 WHERE id = ?", (user_id,))
    row = _row("SELECT session_version FROM users WHERE id = ?", (user_id,))
    return int(row["session_version"]) if row else 0


def export_user_data(user_id: str) -> dict:
    """Everything this teacher put into the app, as one JSON-able dict — for
    self-service data export. Scoped to what they created, not internal
    telemetry (usage_events, the token-metering table entitlement.py reads)
    or the derived retrieval index (curriculum_chunks: their own pacing
    guide's text, re-chunked with embeddings) — both are either not theirs
    to read back or already covered by the original file curriculum_maps
    points at.

    messages has no user_id column of its own — it was always scoped through
    chat_id, so this filters through the same chat ids `chats` returns
    rather than repeating that join logic differently in two places.
    """
    user = get_user_by_id(user_id) or {}
    chats = _rows("SELECT * FROM chats WHERE user_id = ? ORDER BY created_at", (user_id,))
    chat_ids = [c["id"] for c in chats]
    messages = _rows("SELECT * FROM messages WHERE chat_id = ANY(?) ORDER BY chat_id, id", (chat_ids,))
    plans = _rows("SELECT * FROM plans WHERE user_id = ? ORDER BY created_at", (user_id,))
    plan_feedback = _rows("SELECT * FROM plan_feedback WHERE user_id = ? ORDER BY id", (user_id,))
    classes = _rows("SELECT * FROM classes WHERE user_id = ? ORDER BY sort_order", (user_id,))
    settings = _rows("SELECT * FROM settings WHERE user_id = ?", (user_id,))
    curriculum_maps = _rows("SELECT * FROM curriculum_maps WHERE user_id = ? ORDER BY uploaded_at", (user_id,))
    curriculum_progress = _rows(
        "SELECT * FROM curriculum_progress WHERE user_id = ? ORDER BY subject, sort_order", (user_id,)
    )
    return {
        "account": {
            "email": user.get("email"),
            "name": user.get("name"),
            "created_at": user.get("created_at"),
        },
        "settings": settings,
        "classes": classes,
        "chats": chats,
        "messages": messages,
        "plans": plans,
        "plan_feedback": plan_feedback,
        "curriculum_maps": curriculum_maps,
        "curriculum_progress": curriculum_progress,
    }


def delete_user_account(user_id: str) -> None:
    """Permanently deletes this account and everything scoped to it — a hard
    delete, unlike classes' soft-archive (delete_class): "delete my account"
    carries a real expectation of being gone, not archived.

    Deletes in an order that lets each table's own ON DELETE CASCADE take
    the rest of its subtree with it: curriculum_maps takes
    curriculum_progress and curriculum_chunks; plans takes plan_feedback and
    quizzes (which itself takes nothing further); chats takes messages.
    usage_events cascades from the users row itself (the one table that
    already declared a real FK to users, per migration 17). Nothing here is
    reversible — routes/auth.py's delete_account is what gates reaching
    this behind re-entering a password.

    The actual FILES those rows point at — generated .docx plans, QTI quiz
    exports, uploaded pacing guides — used to be left behind on disk and in
    Supabase Storage after this ran, since ON DELETE CASCADE only ever
    touches rows. Collected and removed via storage.remove_file (which
    handles both the local copy and the durable-storage mirror) BEFORE the
    DB rows disappear, since every path lives in a column this query would
    otherwise be deleting a moment later. Best-effort per file — a missing
    or already-gone file must not abort the account deletion itself, which
    is why each removal is wrapped individually rather than trusted to
    storage.remove_file's own internal try/except alone."""
    docx_paths = [r["docx_path"] for r in _rows("SELECT docx_path FROM plans WHERE user_id = ? AND docx_path IS NOT NULL", (user_id,))]
    qti_paths = [
        r["qti_path"] for r in _rows(
            "SELECT q.qti_path FROM quizzes q JOIN plans p ON p.id = q.plan_id "
            "WHERE p.user_id = ? AND q.qti_path IS NOT NULL",
            (user_id,),
        )
    ]
    map_paths = [r["stored_path"] for r in _rows("SELECT stored_path FROM curriculum_maps WHERE user_id = ?", (user_id,))]

    for path_str in [*docx_paths, *qti_paths, *map_paths]:
        try:
            storage.remove_file(Path(path_str))
        except Exception:  # noqa: BLE001 — one bad path must not abort account deletion
            log.warning("delete_user_account: could not remove file %r for user %s", path_str, user_id)

    _write("DELETE FROM curriculum_maps WHERE user_id = ?", (user_id,))
    _write("DELETE FROM plans WHERE user_id = ?", (user_id,))
    _write("DELETE FROM chats WHERE user_id = ?", (user_id,))
    _write("DELETE FROM classes WHERE user_id = ?", (user_id,))
    _write("DELETE FROM settings WHERE user_id = ?", (user_id,))
    _write("DELETE FROM users WHERE id = ?", (user_id,))


def count_plans(user_id: str) -> int:
    """How many weeks this teacher has built. Informational now — the free
    tier no longer gates on this (see migration 17) — but still worth showing
    on the account menu and to admins."""
    row = _row("SELECT COUNT(*) AS n FROM plans WHERE user_id = ?", (user_id,))
    return int(row["n"]) if row else 0


# ── the LLM response cache ───────────────────────────────────────────────


def get_llm_cache(hash_key: str) -> str | None:
    """The read half of llm.py's _cached_completion.

    Both halves were called from day one and neither was ever written, so
    every non-streaming model call in the app — plan generation, both
    revise paths, chat titles, query expansion — raised AttributeError on
    its way to OpenAI. The ones wrapped in a broad `except` degraded quietly
    (a chat kept its truncated title, retrieval ran unexpanded); the ones
    that weren't simply failed. The table itself did not exist either, since
    the migration that creates it sat behind the failing migration 20.

    A miss must never be an error: this is an optimisation, and a cache
    that can take the request down with it is worse than no cache."""
    try:
        row = _row("SELECT response FROM llm_cache WHERE hash_key = ?", (hash_key,))
        return row["response"] if row else None
    except Exception as e:  # noqa: BLE001 — a cold cache beats a failed request
        log.warning("llm cache read failed: %s", e)
        return None


def set_llm_cache(hash_key: str, response: str) -> None:
    """The write half. ON CONFLICT DO NOTHING rather than an upsert: entries
    are keyed by a hash of the exact request, so a second write for the same
    key is by definition the same answer, and two concurrent identical calls
    racing here is normal rather than a conflict worth resolving."""
    try:
        _write(
            "INSERT INTO llm_cache (hash_key, created_at, response) VALUES (?, ?, ?) "
            "ON CONFLICT (hash_key) DO NOTHING",
            (hash_key, now(), response),
        )
    except Exception as e:  # noqa: BLE001 — same reasoning as the read
        log.warning("llm cache write failed: %s", e)


def record_usage(user_id: str, kind: str, tokens_in: int, tokens_out: int) -> None:
    """One row per model call. Metering must never be why the call it's
    metering fails — a teacher's plan should not error out because logging
    its cost did."""
    try:
        _write(
            "INSERT INTO usage_events (id, user_id, created_at, kind, tokens_in, tokens_out) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (new_id(), user_id, now(), kind, int(tokens_in or 0), int(tokens_out or 0)),
        )
    except Exception:
        log.exception("failed to record usage user_id=%s kind=%s", user_id, kind)


def record_audit_log(
    actor_user_id: str | None, action: str, *, target_user_id: str | None = None, detail: dict | None = None
) -> None:
    """One row per sensitive action — admin account changes, self-service
    export/delete — for the same reason record_usage never lets a metering
    failure fail the call it's metering: an audit trail that can take down
    the action it's recording is worse than an audit trail with a gap.
    """
    try:
        _write(
            "INSERT INTO audit_log (id, created_at, actor_user_id, action, target_user_id, detail) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (new_id(), now(), actor_user_id, action, target_user_id, json.dumps(detail) if detail else None),
        )
    except Exception:
        log.exception("failed to record audit log actor=%s action=%s", actor_user_id, action)


def list_audit_log(limit: int = 200) -> list[dict]:
    """Most recent actions first, for the admin page — bounded so the page
    can't be turned into an unpaginated full-table dump."""
    return _rows("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?", (int(limit),))


def tokens_used_since(user_id: str, since_iso: str) -> int:
    """Total input+output tokens this account has spent since `since_iso` —
    what entitlement.py caps against instead of a plan count."""
    row = _row(
        "SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS n FROM usage_events "
        "WHERE user_id = ? AND created_at >= ?",
        (user_id, since_iso),
    )
    return int(row["n"]) if row else 0


def tokens_used_two_windows(user_id: str, since_iso: str, burst_since_iso: str) -> tuple[int, int]:
    """(total since `since_iso`, total since `burst_since_iso`) in ONE query.

    entitlement() needs both the trailing-week total and the much shorter
    burst window, and used to call tokens_used_since twice for it. Every call
    into this module borrows a pooled connection and issues its own
    `SET LOCAL app.user_id` first (see borrow()), so a second aggregate here
    was two extra network round trips to the pooler for a strictly narrower
    slice of rows the first one already scanned. The burst window is a subset
    of the week, so a FILTER clause gets it off the same scan.

    Callers pass burst_since_iso >= since_iso; nothing checks it, but the
    burst number is meaningless otherwise."""
    row = _row(
        "SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS n, "
        "       COALESCE(SUM(tokens_in + tokens_out) FILTER (WHERE created_at >= ?), 0) AS recent "
        "FROM usage_events WHERE user_id = ? AND created_at >= ?",
        (burst_since_iso, user_id, since_iso),
    )
    if not row:
        return 0, 0
    return int(row["n"]), int(row["recent"])


def set_subscription(user_id: str, *, customer_id: str | None = None, status: str | None = None,
                     period_end: str | None = None) -> None:
    """Write back whatever Stripe just told us. Only the fields provided, so a
    webhook carrying a status doesn't blank a customer id."""
    sets, params = [], []
    if customer_id is not None:
        sets.append("stripe_customer_id = ?"); params.append(customer_id)
    if status is not None:
        sets.append("subscription_status = ?"); params.append(status)
    if period_end is not None:
        sets.append("subscription_period_end = ?"); params.append(period_end)
    if not sets:
        return
    params.append(user_id)
    _write(f"UPDATE users SET {', '.join(sets)} WHERE id = ?", tuple(params))


def clear_subscription_status(user_id: str) -> None:
    """Revoke comped access (or any status) back to NULL — "no subscription",
    the same state a brand-new signup starts in. Separate from
    set_subscription because that function treats status=None as "don't
    touch"; there was no way to ask it for an actual NULL."""
    _write("UPDATE users SET subscription_status = NULL WHERE id = ?", (user_id,))


def get_user_by_stripe_customer(customer_id: str) -> dict | None:
    return _row("SELECT * FROM users WHERE stripe_customer_id = ?", (customer_id,))


def set_drive_tokens(
    user_id: str, *, access_token: str, refresh_token: str, expires_at: str, scope: str
) -> None:
    """The one grant a teacher gives this app: upserted, not appended — a
    re-authorization (say, after revoking access in their Google account and
    reconnecting) replaces the row outright, so a stale refresh_token from a
    dead grant can never end up paired with a fresh access_token that
    doesn't actually go with it."""
    _write(
        """INSERT INTO google_drive_tokens
               (user_id, access_token, refresh_token, expires_at, scope, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (user_id) DO UPDATE SET
               access_token = EXCLUDED.access_token,
               refresh_token = EXCLUDED.refresh_token,
               expires_at = EXCLUDED.expires_at,
               scope = EXCLUDED.scope,
               updated_at = EXCLUDED.updated_at""",
        (user_id, access_token, refresh_token, expires_at, scope, now(), now()),
    )


def get_drive_tokens(user_id: str) -> dict | None:
    return _row("SELECT * FROM google_drive_tokens WHERE user_id = ?", (user_id,))


def set_drive_access_token(user_id: str, *, access_token: str, expires_at: str) -> None:
    """Just the half a refresh actually replaces. Google's refresh_token is
    reused across refreshes, not reissued, so overwriting it here on every
    call would mean holding onto whichever access token happened to be
    exchanged last while silently losing the ability to ever refresh again
    the one time Google DOES rotate it."""
    _write(
        "UPDATE google_drive_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ?",
        (access_token, expires_at, now(), user_id),
    )


def clear_drive_tokens(user_id: str) -> None:
    _write("DELETE FROM google_drive_tokens WHERE user_id = ?", (user_id,))


def is_admin(user_id: str) -> bool:
    row = _row("SELECT is_admin FROM users WHERE id = ?", (user_id,))
    return bool(row and row["is_admin"])


def list_accounts_with_stats() -> list[dict]:
    """Every account, its billing state, and what it's actually built.

    Exists so managing accounts is a page in the app rather than SQL run by
    hand against production. One query, not N+1 — plans_built, last_plan_at
    and tokens_used are all aggregated in the same round trip.

    tokens_used mirrors entitlement.py's own trailing-window usage figure —
    same 7-day literal, duplicated rather than imported (entitlement.py
    already imports this module, so the reverse import would be circular).
    It's what moved this number OFF the per-teacher settings page and onto
    this admin table instead: one place to see who's using what, not a
    number every teacher stares at on their own account.
    """
    since_7d = (datetime.now(UTC) - timedelta(days=7)).isoformat(timespec="seconds")
    since_30d = (datetime.now(UTC) - timedelta(days=30)).isoformat(timespec="seconds")
    # Same 24h window entitlement.py's own burst cap checks — so this table
    # can show which accounts are CURRENTLY riding close to it, not just
    # their weekly total.
    since_burst = (datetime.now(UTC) - timedelta(hours=24)).isoformat(timespec="seconds")
    rows = _rows(
        """
        SELECT u.id, u.email, u.name, u.subscription_status, u.is_admin, u.created_at,
               u.custom_weekly_token_cap, u.beta_expires_at,
               COUNT(p.id) AS plans_built,
               MAX(p.created_at) AS last_plan_at,
               COALESCE(ue7.tokens, 0) AS tokens_7d,
               COALESCE(ue30.tokens, 0) AS tokens_30d,
               COALESCE(ueburst.tokens, 0) AS tokens_burst
        FROM users u
        LEFT JOIN plans p ON p.user_id = u.id
        LEFT JOIN (
            SELECT user_id, SUM(tokens_in + tokens_out) AS tokens
            FROM usage_events
            WHERE created_at >= ?
            GROUP BY user_id
        ) ue7 ON ue7.user_id = u.id
        LEFT JOIN (
            SELECT user_id, SUM(tokens_in + tokens_out) AS tokens
            FROM usage_events
            WHERE created_at >= ?
            GROUP BY user_id
        ) ue30 ON ue30.user_id = u.id
        LEFT JOIN (
            SELECT user_id, SUM(tokens_in + tokens_out) AS tokens
            FROM usage_events
            WHERE created_at >= ?
            GROUP BY user_id
        ) ueburst ON ueburst.user_id = u.id
        GROUP BY u.id, u.email, u.name, u.subscription_status, u.is_admin, u.created_at,
                 u.custom_weekly_token_cap, u.beta_expires_at, ue7.tokens, ue30.tokens, ueburst.tokens
        ORDER BY u.created_at DESC
        """,
        (since_7d, since_30d, since_burst),
    )
    res = []
    for r in rows:
        d = dict(r)
        d["tokens_avg_day_30d"] = int(d["tokens_30d"] / 30) if d.get("tokens_30d") else 0
        res.append(d)
    return res


def weekly_usage_series(weeks: int = 8) -> list[dict]:
    """Site-wide token usage, bucketed by week — the admin panel's trend
    chart. list_accounts_with_stats already answers "how much right now"
    (a 7-day snapshot per account); this answers "is it growing," which a
    single snapshot can't, no matter how often it's refreshed.

    date_trunc, not a Python-side groupby — usage_events can be a real
    table by the time anyone's looking at eight weeks of it, and letting
    Postgres do the bucketing means one aggregate query instead of hauling
    every row of eight weeks across the wire to sum in Python.
    """
    since = (datetime.now(UTC) - timedelta(weeks=weeks)).isoformat(timespec="seconds")
    rows = _rows(
        """
        SELECT date_trunc('week', created_at::timestamptz) AS week_start,
               SUM(tokens_in + tokens_out) AS tokens
        FROM usage_events
        WHERE created_at >= ?
        GROUP BY week_start
        ORDER BY week_start ASC
        """,
        (since,),
    )
    return [
        {"week_start": r["week_start"].isoformat(), "tokens": int(r["tokens"] or 0)}
        for r in rows
    ]


def list_plans_for_standards_qa() -> list[dict]:
    """Every plan that has a class to check it against — admin-wide, across
    every account, for the standards spot-check (backend/qa.py).

    Only plans with a class_id are returned: a plan's own subject/grade
    comes from its class (see backend/service.py's own warning that
    plans.course is a free-text display string, never a join key), so a
    plan with no class_id has nothing this check can verify it against.
    Those are legacy/orphaned rows (class_id landed after `plans` did), not
    a gap in the check.
    """
    return _rows(
        """
        SELECT p.id AS plan_id, p.user_id, p.week_label, p.retrieved_ids,
               c.subject, c.grade, u.email
        FROM plans p
        JOIN classes c ON c.id = p.class_id
        JOIN users u ON u.id = p.user_id
        WHERE p.class_id IS NOT NULL
        ORDER BY p.created_at DESC
        """
    )


def set_custom_token_cap(user_id: str, cap: int | None) -> None:
    """An admin override on top of the two tier defaults (config.py) — see
    migration 28. `cap=None` clears it back to "use the tier's own cap"."""
    _write("UPDATE users SET custom_weekly_token_cap = ? WHERE id = ?", (cap, user_id))


# get_app_settings' singleton row, and when it was read. One row, changed by
# hand from the admin Settings tab maybe a handful of times ever, but read on
# EVERY entitlement check — i.e. on every /api/auth/me and every generate.
# A few seconds of staleness on a cap change is unnoticeable; a pooler round
# trip per request for a row that essentially never changes is not.
_APP_SETTINGS_TTL_SECONDS = 30
_app_settings_cache: tuple[float, dict] | None = None
_app_settings_lock = threading.Lock()


def get_app_settings() -> dict:
    """The two admin-editable weekly token caps. Falls back to config.py's
    defaults if the singleton row is somehow missing (never happens after
    migration 28 runs, but a missing row should degrade to the pre-Settings-
    tab behavior rather than a 500).

    Cached for _APP_SETTINGS_TTL_SECONDS — see that constant. Invalidated
    outright by set_app_settings so an admin's own change is visible to them
    immediately rather than up to the TTL later, which would read as the save
    having silently failed."""
    global _app_settings_cache
    cached = _app_settings_cache
    if cached and (time.monotonic() - cached[0]) < _APP_SETTINGS_TTL_SECONDS:
        return cached[1]
    row = _row("SELECT * FROM app_settings WHERE id = true")
    value = row if row else {
        "free_weekly_token_cap": settings.free_weekly_token_cap,
        "subscriber_weekly_token_cap": settings.subscriber_weekly_token_cap,
        "updated_at": None,
        "updated_by": None,
    }
    with _app_settings_lock:
        _app_settings_cache = (time.monotonic(), value)
    return value


def _invalidate_app_settings_cache() -> None:
    global _app_settings_cache
    with _app_settings_lock:
        _app_settings_cache = None


def update_app_settings(*, free_weekly_token_cap: int, subscriber_weekly_token_cap: int, actor_id: str) -> dict:
    _write(
        """
        UPDATE app_settings
        SET free_weekly_token_cap = ?, subscriber_weekly_token_cap = ?, updated_at = ?, updated_by = ?
        WHERE id = true
        """,
        (free_weekly_token_cap, subscriber_weekly_token_cap, now(), actor_id),
    )
    # Before the re-read, so the admin who just saved sees their own new value
    # rather than up to _APP_SETTINGS_TTL_SECONDS of the old one — which would
    # read as the save having silently failed.
    _invalidate_app_settings_cache()
    return get_app_settings()


def log_admin_action(actor_id: str, action: str, target: str | None = None, detail: dict | None = None) -> None:
    """One row per admin action — comp grant/revoke, school add/remove,
    a settings change. Never raised on failure to the caller: an admin
    action that succeeded but went unlogged is a worse outcome than one
    with a thin log entry, not one that gets undone or refused."""
    _write(
        "INSERT INTO admin_audit_log (actor_id, action, target, detail, created_at) VALUES (?,?,?,?,?)",
        (actor_id, action, target, json.dumps(detail) if detail is not None else None, now()),
    )


def list_admin_audit_log(limit: int = 50) -> list[dict]:
    """Most recent admin actions, actor's email joined in — the log table
    only has actor_id, and the page has no use for a bare uuid."""
    rows = _rows(
        """
        SELECT l.id, l.action, l.target, l.detail, l.created_at,
               u.email AS actor_email
        FROM admin_audit_log l
        LEFT JOIN users u ON u.id = l.actor_id
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ?
        """,
        (limit,),
    )
    for r in rows:
        r["detail"] = json.loads(r["detail"]) if r.get("detail") else None
    return rows


def billing_summary() -> dict:
    """Account counts by subscription_status, plus the 'past_due' accounts by
    name — the two things an admin actually needs from Stripe without
    calling Stripe: how many people are paying, and who's at risk of losing
    access because a card failed. 'past_due' is set by the same webhook
    (routes/billing.py) that would otherwise only ever be seen in the Stripe
    dashboard, so this is that state surfaced somewhere an admin already is.

    MRR is computed by the caller (routes/admin.py), not here — it needs the
    live Stripe price, which is a network call this DB layer has no business
    making.
    """
    counts = _rows(
        "SELECT COALESCE(subscription_status, 'none') AS status, COUNT(*) AS n FROM users GROUP BY subscription_status"
    )
    past_due = _rows(
        "SELECT id, email, name, subscription_period_end FROM users WHERE subscription_status = 'past_due' ORDER BY email"
    )
    return {
        "counts": {row["status"]: row["n"] for row in counts},
        "past_due_accounts": past_due,
    }


def create_user(email: str, name: str, password_hash: str) -> dict:
    uid = new_id()
    _write(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
        (uid, email.strip().lower(), name.strip(), password_hash, now()),
    )
    return get_user_by_id(uid)  # type: ignore[return-value]


def create_beta_account(email: str, name: str, password_hash: str, *, days: int) -> dict:
    """A real account — same table, same login, same everything a normal
    signup gets (no classes yet, onboarding_seen_at NULL, so it goes through
    /welcome and the onboarding wizard exactly like a brand-new teacher) —
    with two things a normal signup doesn't get:

      subscription_status = 'active' — the SUBSCRIBER tier cap
      (settings.subscriber_weekly_token_cap), not 'comped' (unlimited) and
      not the free tier. entitlement.py's `unlimited` flag is keyed
      specifically on 'comped', so this account experiences real usage
      limits — the same ones a paying teacher would — rather than either
      extreme.

      beta_expires_at = now + `days` — checked in deps._verify_current on
      every request; past that timestamp the account's session simply stops
      verifying, the same as if the cookie had expired on its own. No
      separate revocation step is needed once this is set.
    """
    uid = new_id()
    expires = (datetime.now(UTC) + timedelta(days=days)).isoformat(timespec="seconds")
    _write(
        """
        INSERT INTO users (id, email, name, password_hash, subscription_status, beta_expires_at, created_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT (id) DO NOTHING
        """,
        (uid, email.strip().lower(), name.strip(), password_hash, expires, now()),
    )
    return get_user_by_id(uid)  # type: ignore[return-value]


def extend_beta_account(user_id: str, *, days: int) -> dict | None:
    """Add `days` more from right now — not from the original expiry — so
    "give them another week" always means a week from today, regardless of
    whether the old window had already lapsed."""
    expires = (datetime.now(UTC) + timedelta(days=days)).isoformat(timespec="seconds")
    _write("UPDATE users SET beta_expires_at = ? WHERE id = ?", (expires, user_id))
    return get_user_by_id(user_id)


def end_beta_account(user_id: str) -> None:
    """Ends the trial immediately (next request, not next login) rather than
    waiting out the original window. Does not touch subscription_status —
    revoking the trial and revoking the usage tier are two different
    decisions; an admin who wants both clears the status separately via the
    existing comp/cap endpoints."""
    _write(
        "UPDATE users SET beta_expires_at = ? WHERE id = ?",
        (now(), user_id),
    )


_USER_FIELDS = {"name", "custom_instructions", "school", "beta_features", "output_length"}


def update_user(user_id: str, **fields: Any) -> dict | None:
    """Whitelisted per-account fields — mirrors update_class's own
    _CLASS_FIELDS pattern. Was update_user_name (name only); generalized so
    custom_instructions (global instructions applied to every generation,
    see backend/prompts.py) didn't need a second near-identical function.

    name carries one side effect custom_instructions doesn't: it used to
    live on every settings row, which meant retyping it per class and gave
    two rows the chance to disagree — sync_settings_from_class projects it
    back down after the write, so this stays the only place it's authored.
    """
    sets = {
        k: (v.strip()[:120] if k == "name" else v)
        for k, v in fields.items()
        if k in _USER_FIELDS and v is not None
    }
    if not sets:
        return get_user_by_id(user_id)
    clause = ", ".join(f"{k} = ?" for k in sets)
    _write(f"UPDATE users SET {clause} WHERE id = ?", (*sets.values(), user_id))
    if "name" in sets:
        # Push the new name onto every class's settings row so plan headers follow.
        for cls in list_classes(user_id):
            sync_settings_from_class(user_id, cls["id"])
    return get_user_by_id(user_id)


def update_user_avatar(user_id: str, avatar: str | None) -> dict | None:
    """Not folded into update_user's generic **fields whitelist — that path
    skips any field whose value is None (`if ... and v is not None`), which
    is exactly the value the picker's own "Default" option needs to write to
    clear a previous selection (frontend/src/pages/SettingsPage.jsx's
    AvatarSelect calls handleSelect(null))."""
    _write("UPDATE users SET avatar = ? WHERE id = ?", (avatar, user_id))
    return get_user_by_id(user_id)


def mark_onboarding_seen(user_id: str) -> dict | None:
    """Stamps NOW rather than a bare boolean — 'when' is worth having if this
    ever needs a one-time re-prompt for a redesigned wizard later (compare
    against a new "wizard version" cutoff), which a plain flag can't answer.
    Idempotent: re-marking an already-seen account just moves the timestamp
    forward, which is harmless since nothing reads it as a first-seen date."""
    _write("UPDATE users SET onboarding_seen_at = ? WHERE id = ?", (now(), user_id))
    return get_user_by_id(user_id)


# claim_user() was here, and is deliberately gone.
#
# It set a password on any account whose password_hash was NULL and returned
# that account, and routes/auth.py's signup() then issued a session for it. The
# docstring justified it as "a placeholder seat (the 'default_user' row seeded
# by the v6 migration, or any future account created without a login)" — but
# Google sign-in creates real accounts in exactly that state, so the function
# amounted to "hand this account to whoever asks for it by email". Verified as a
# working account takeover before removal. signup() was its only caller and
# there is no seat-provisioning flow in this app, so nothing replaced it.
#
# Note the second flaw, in case this shape is ever reintroduced: the UPDATE was
# guarded with `AND password_hash IS NULL`, but the return was an unconditional
# get_user_by_id(). So even when the write correctly did nothing, the caller
# still received the user and logged in as them. A guard that protects the write
# but not the value handed back is not a guard.


def get_user_by_google_sub(google_sub: str) -> dict | None:
    """Look up an account by Google's immutable subject id (migration 40)."""
    if not google_sub:
        return None
    return _row("SELECT * FROM users WHERE google_sub = ?", (google_sub,))


def link_google_sub(user_id: str, google_sub: str) -> None:
    """Attach a Google account id to a user row, once.

    `AND google_sub IS NULL` so a re-link can never move an existing linkage,
    and so two concurrent sign-ins cannot fight over it. Existing accounts
    (which predate the column) pick theirs up on the next Google sign-in.
    """
    if not google_sub:
        return
    _write(
        "UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL",
        (google_sub, user_id),
    )


def update_password(user_id: str, password_hash: str) -> None:
    """The generic case claim_user() explicitly is not: setting a password on
    an account that already has one (forgot-password, change-password in
    settings). Unconditional on the existing hash — the caller has already
    verified either the old password or a valid reset token before this runs."""
    _write("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))

def get_global_standards(state: str, subject: str, grade: str) -> list[dict]:
    return _rows(
        "SELECT * FROM global_standards WHERE state = ? AND subject = ? AND grade = ? ORDER BY code",
        (state, subject, grade)
    )

def insert_global_standards(user_id: str, state: str, subject: str, grade: str, standards: list[dict]) -> None:
    for std in standards:
        _write(
            """
            INSERT INTO global_standards (state, subject, grade, code, description, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (state, subject, grade, code) DO UPDATE SET
                description = excluded.description
            """,
            (state, subject, grade, std["code"], std["description"], user_id, now())
        )

def get_standards_coverage(class_id: str) -> dict[str, int]:
    """Returns a mapping of standard code to citation count for a given class."""
    rows = _rows(
        "SELECT code, COUNT(DISTINCT plan_id) as cnt FROM plan_standards WHERE class_id = ? AND status = 'grounded' GROUP BY code",
        (class_id,)
    )
    return {r["code"]: r["cnt"] for r in rows}

def get_standard_lessons(class_id: str, code: str) -> list[dict]:
    """Returns the lesson plans in a class that successfully cite a specific standard."""
    return _rows(
        """
        SELECT DISTINCT p.id, p.title, p.created_at 
        FROM plan_standards ps
        JOIN plans p ON p.id = ps.plan_id
        WHERE ps.class_id = ? AND ps.code = ? AND ps.status = 'grounded'
        ORDER BY p.created_at DESC
        LIMIT 10
        """,
        (class_id, code)
    )
