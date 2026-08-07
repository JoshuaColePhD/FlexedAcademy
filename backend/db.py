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

import json
import logging
import psycopg2
from psycopg2.pool import ThreadedConnectionPool
from psycopg2.extras import RealDictCursor
from pgvector.psycopg2 import register_vector
import threading
from contextlib import contextmanager
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_classes_user ON classes(user_id, archived, sort_order);

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
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
            )
            log.info("db pool opened (max %d connections)", settings.db_pool_size)
    return _pool


@contextmanager
def borrow():
    """Borrow a connection for the duration of one statement, and always give it
    back — including on the error paths, which is the failure mode that turns a
    pool into an outage."""
    pool = _ensure_pool()
    _slots.acquire()
    try:
        conn = pool.getconn()
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
        except Exception:
            pass
        raise
    finally:
        pool.putconn(conn)
        _slots.release()


def migrate(conn: psycopg2.extensions.connection) -> None:
    with conn.cursor() as cur:
        cur.execute('''
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            )
        ''')
        cur.execute('SELECT MAX(version) FROM schema_version')
        version_row = cur.fetchone()
        version = version_row['max'] if version_row and version_row['max'] is not None else 0
        
        for i, script in enumerate(MIGRATIONS[version:], start=version):
            log.info("applying migration %d", i + 1)
            cur.execute(script)
            cur.execute("INSERT INTO schema_version (version) VALUES (%s) ON CONFLICT (version) DO NOTHING", (i + 1,))
            conn.commit()
                
        try:
            register_vector(conn)
        except psycopg2.ProgrammingError:
            pass


def close() -> None:
    global _pool
    if _pool is not None:
        _pool.closeall()
        _pool = None


def _write(sql: str, params: tuple = ()) -> psycopg2.extensions.cursor:
    with borrow() as conn:
        with conn.cursor() as cur:
            # psycopg2 uses %s for placeholders instead of ?
            cur.execute(sql.replace("?", "%s"), params)
        conn.commit()
        return cur


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    with borrow() as conn:
        with conn.cursor() as cur:
            cur.execute(sql.replace("?", "%s"), params)
            return [dict(r) for r in cur.fetchall()]


def _row(sql: str, params: tuple = ()) -> dict | None:
    with borrow() as conn:
        with conn.cursor() as cur:
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


def create_class(user_id: str, *, name: str, subject: str, grade: str) -> dict:
    class_id = new_id()
    row = _row("SELECT COALESCE(MAX(sort_order), -1) AS m FROM classes WHERE user_id = ?", (user_id,))
    _write(
        """
        INSERT INTO classes (id, user_id, name, subject, grade, sort_order, archived, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
        """,
        (class_id, user_id, name.strip()[:120], subject, str(grade), int(row["m"]) + 1, now()),
    )
    # Mirror into settings so the generate path, which still reads
    # get_settings_row(user_id), sees this class the moment it is created.
    sync_settings_from_class(user_id, class_id)
    return get_class(user_id, class_id)


_CLASS_FIELDS = {"name", "subject", "grade", "sort_order", "archived"}


def update_class(user_id: str, class_id: str, **fields: Any) -> dict | None:
    sets = {k: v for k, v in fields.items() if k in _CLASS_FIELDS and v is not None}
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
    cur = _write("UPDATE classes SET archived = 1 WHERE id = ? AND user_id = ?", (class_id, user_id))
    return cur.rowcount > 0


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


def get_plan(user_id: str, plan_id: str) -> dict | None:
    row = _row("SELECT * FROM plans WHERE id = ? AND user_id = ?", (plan_id, user_id))
    return _hydrate_plan(row) if row else None


def list_plans(user_id: str, *, limit: int = 50, offset: int = 0, q: str | None = None, class_id: str | None = None) -> dict:
    where, params = "WHERE user_id = ?", [user_id]
    if class_id:
        where += " AND class_id = ?"
        params.append(class_id)
    if q:
        where += " AND (week_label LIKE ? OR query LIKE ? OR unit LIKE ?)"
        like = f"%{q}%"
        params += [like, like, like]

    total = _row(f"SELECT COUNT(*) AS n FROM plans {where}", tuple(params))["n"]  # type: ignore[index]
    rows = _rows(
        f"SELECT * FROM plans {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        tuple(params + [limit, offset]),
    )
    items = []
    for r in rows:
        p = _hydrate_plan(r)
        p.pop("plan_json", None)  # list view doesn't need the whole week
        items.append(p)
    return {"items": items, "total": total}


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
    return _write("DELETE FROM plans WHERE id = ? AND user_id = ?", (plan_id, user_id)).rowcount > 0


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
        datetime.strptime(value, "%Y-%m-%d")
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
    """Only one ACTIVE document per (class, kind) — re-uploading a pacing guide
    replaces it — but the kinds coexist, which is the point."""
    if kind not in DOCUMENT_KINDS:
        kind = "other"
    _write(
        "UPDATE curriculum_maps SET active = 0 WHERE user_id = ? AND class_id = ? AND kind = ?",
        (user_id, class_id, kind),
    )
    _write(
        """INSERT INTO curriculum_maps
             (id, user_id, class_id, subject, kind, original_name, stored_path, chars, active, uploaded_at)
           VALUES (?,?,?,?,?,?,?,?,1,?)""",
        (map_id, user_id, class_id, subject, kind, original_name, stored_path, chars, now()),
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
    prompt quotes — backend/context/school_calendar.md — so a week the school is
    closed can be shown as closed rather than offered as a plan to build."""
    from . import schoolcal  # local: keeps the calendar out of db's import cycle

    cls = resolve_class(user_id, class_id)
    weeks = schoolcal.school_weeks()
    if not weeks:
        return {"class": cls, "weeks": [], "current_week": None}

    # Which weeks already have a plan. class_id is the key where one exists;
    # plans written before migration 9 only have the course display name, so
    # both are accepted rather than showing a teacher's own back-catalogue as
    # unplanned.
    if cls:
        rows = _rows(
            "SELECT week_label, week_number, id, unit, class_id, course FROM plans WHERE user_id = ? AND (class_id = ? OR (class_id IS NULL AND course = ?))",
            (user_id, cls["id"], cls["name"]),
        )
    else:
        rows = _rows("SELECT week_label, week_number, id, unit, class_id, course FROM plans WHERE user_id = ?", (user_id,))

    from .units import week_number

    by_week: dict[int, dict] = {}
    for r in rows:
        # The stored column is the week the teacher asked for; the label parse is
        # only a fallback for rows written before migration 11 whose backfill
        # found nothing.
        n = r.get("week_number") or week_number(r["week_label"] or "")
        if n is not None:
            by_week.setdefault(n, {"plan_id": r["id"], "week_label": r["week_label"], "unit": r.get("unit")})

    today = now()[:10]
    current = schoolcal.week_for()
    out = []
    for w in weeks:
        plan = by_week.get(w["week"])
        days = schoolcal.week_days(w)
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
                # What the week is ABOUT. The board shows this instead of
                # repeating the date that is already in the row's date column.
                "unit": (plan or {}).get("unit"),
                "has_plan": plan is not None,
                "is_current": bool(current and current["week"] == w["week"]),
                "is_past": w["end"] < today,
            }
        )

    return {
        "class": cls,
        "weeks": out,
        "current_week": current["week"] if current else None,
    }


# ---------------------------------------------------------------------------
# Chats & messages
# ---------------------------------------------------------------------------


def create_chat(user_id: str, title: str, chat_id: str | None = None) -> dict:
    cid = chat_id or new_id()
    ts = now()
    _write(
        "INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
        (cid, user_id, title[:200], ts, ts),
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


def list_chats(user_id: str, limit: int = 100) -> list[dict]:
    return [
        dict(r)
        for r in _rows(
            "SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?", (user_id, limit)
        )
    ]


def rename_chat(user_id: str, chat_id: str, title: str) -> dict | None:
    _write(
        "UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (title[:200], now(), chat_id, user_id),
    )
    return get_chat(user_id, chat_id)


def delete_chat(user_id: str, chat_id: str) -> bool:
    return _write("DELETE FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id)).rowcount > 0


def add_message(chat_id: str, role: str, content: str, plan_id: str | None = None) -> dict:
    """Not user-scoped: callers must already have verified (via get_chat) that
    this chat belongs to the requesting user. Messages have no user_id column
    of their own — ownership lives entirely on the parent chat."""
    cur = _write(
        "INSERT INTO messages (chat_id, role, content, plan_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
        (chat_id, role, content, plan_id, now()),
    )
    _write("UPDATE chats SET updated_at = ? WHERE id = ?", (now(), chat_id))
    return {
        "id": 0,
        "chat_id": chat_id,
        "role": role,
        "content": content,
        "plan_id": plan_id,
    }


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


def create_user(email: str, name: str, password_hash: str) -> dict:
    uid = new_id()
    _write(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
        (uid, email.strip().lower(), name.strip(), password_hash, now()),
    )
    return get_user_by_id(uid)  # type: ignore[return-value]


def update_user_name(user_id: str, name: str) -> dict | None:
    """The teacher's name, asked once for the whole app.

    It used to live on every settings row, which meant retyping it per class and
    gave two rows the chance to disagree. sync_settings_from_class projects this
    back down onto settings, so this is the only place it is authored."""
    _write("UPDATE users SET name = ? WHERE id = ?", (name.strip()[:120], user_id))
    # Push the new name onto every class's settings row so plan headers follow.
    for cls in list_classes(user_id):
        sync_settings_from_class(user_id, cls["id"])
    return get_user_by_id(user_id)


def claim_user(user_id: str, name: str, password_hash: str) -> dict:
    """Sets a password on a placeholder account (password_hash IS NULL) —
    the 'default_user' row seeded by the v6 migration, or any future account
    created without a login (an admin-provisioned seat, say). Not a generic
    password reset: only works while password_hash is still NULL."""
    _write(
        "UPDATE users SET name = ?, password_hash = ? WHERE id = ? AND password_hash IS NULL",
        (name.strip(), password_hash, user_id),
    )
    return get_user_by_id(user_id)  # type: ignore[return-value]
