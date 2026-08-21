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
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg2
from pgvector.psycopg2 import register_vector
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

current_user_id = contextvars.ContextVar("current_user_id", default=None)

from .config import settings
from .errors import AppError

log = logging.getLogger("aplang.db")

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
]


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _new_connection() -> psycopg2.extensions.connection:
    if not settings.database_url:
        raise ValueError("DATABASE_URL is not set in .env")

    try:
        conn = psycopg2.connect(settings.database_url, cursor_factory=RealDictCursor)
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
                dsn=settings.database_url,
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


# ---------------------------------------------------------------------------
# Settings (singleton)
# ---------------------------------------------------------------------------

DEFAULT_SETTINGS = {
    "teacher": "Josh Cole",
    "course": "AP Language & Composition",
    "period": "3rd period",
    "subject": "AP Language & Composition",
    "grade": "11",
}


def get_settings_row(user_id: str = "default_user", subject: str | None = None) -> dict:
    if subject is not None:
        row = _row("SELECT * FROM settings WHERE user_id = ? AND subject = ?", (user_id, subject))
    else:
        # Get the most recently updated settings profile for this user
        row = _row("SELECT * FROM settings WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", (user_id,))
        
    if row is None:
        target_subject = subject or DEFAULT_SETTINGS["subject"]
        _write(
            "INSERT INTO settings (user_id, subject, teacher, course, period, grade, updated_at) VALUES (?,?,?,?,?,?,?)",
            (
                user_id,
                target_subject,
                DEFAULT_SETTINGS["teacher"],
                DEFAULT_SETTINGS["course"],
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


_CLASS_FIELDS = {"name", "subject", "grade", "sort_order", "archived", "school"}


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
    return _write("UPDATE schools SET template_status = ? WHERE id = ?", (status, school_id)) > 0

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
    allowed = {"plan_json", "week_label", "unit", "docx_path", "warnings", "course", "class_id"}
    sets, params = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        sets.append(f"{k} = ?")
        params.append(json.dumps(v) if k in ("plan_json", "warnings") else v)
    if sets:
        params += [plan_id, user_id]
        _write(f"UPDATE plans SET {', '.join(sets)} WHERE id = ? AND user_id = ?", tuple(params))
    return get_plan(user_id, plan_id)


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
    d["has_qti"] = bool(d.get("qti_path")) and Path(d["qti_path"]).is_file()
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
) -> dict:
    """Not user-scoped: callers must already have verified (via get_chat) that
    this chat belongs to the requesting user. Messages have no user_id column
    of their own — ownership lives entirely on the parent chat."""
    with borrow() as conn:
        with conn.cursor() as cur:
            if client_id:
                cur.execute(
                    """
                    INSERT INTO messages (chat_id, role, content, plan_id, client_id, created_at)
                    VALUES (%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (chat_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
                    RETURNING id, chat_id, role, content, plan_id, client_id, created_at
                    """,
                    (chat_id, role, content, plan_id, client_id[:128], now()),
                )
                row = cur.fetchone()
                if row is None:
                    cur.execute(
                        "SELECT id, chat_id, role, content, plan_id, client_id, created_at FROM messages WHERE chat_id = %s AND client_id = %s",
                        (chat_id, client_id[:128]),
                    )
                    row = cur.fetchone()
            else:
                cur.execute(
                    """
                    INSERT INTO messages (chat_id, role, content, plan_id, created_at)
                    VALUES (%s,%s,%s,%s,%s)
                    RETURNING id, chat_id, role, content, plan_id, client_id, created_at
                    """,
                    (chat_id, role, content, plan_id, now()),
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
    curriculum_progress and curriculum_chunks; plans takes plan_feedback;
    chats takes messages. usage_events cascades from the users row itself
    (the one table that already declared a real FK to users, per migration
    17). Nothing here is reversible — routes/auth.py's delete_account is
    what gates reaching this behind re-entering a password.
    """
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


def tokens_used_since(user_id: str, since_iso: str) -> int:
    """Total input+output tokens this account has spent since `since_iso` —
    what entitlement.py caps against instead of a plan count."""
    row = _row(
        "SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS n FROM usage_events "
        "WHERE user_id = ? AND created_at >= ?",
        (user_id, since_iso),
    )
    return int(row["n"]) if row else 0


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


_USER_FIELDS = {"name", "custom_instructions", "school"}


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
