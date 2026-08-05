"""SQLite persistence.

Replaces the frontend's localStorage['lesson_chats'], which was the only record
of any conversation and white-screened the app permanently if it ever held
corrupt JSON.

On location: the database deliberately does NOT live in the repo. See
config._default_db_path() for why (Google Drive + SQLite WAL sidecars).

On the multi-user seam: every table is keyed by an opaque TEXT id and every
query goes through this module. Adding users later is `ALTER TABLE ... ADD
COLUMN user_id` plus a WHERE clause here — cheap precisely because no handler
inlines SQL. There is deliberately no users table and no profile abstraction
now; settings is a DB-enforced singleton.
"""
from __future__ import annotations

import json
import logging
import psycopg2
from psycopg2.extras import RealDictCursor
from pgvector.psycopg2 import register_vector
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings

log = logging.getLogger("aplang.db")

_conn: psycopg2.extensions.connection | None = None
_lock = threading.Lock()

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
    """
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def connect() -> psycopg2.extensions.connection:
    global _conn
    if _conn is not None and not _conn.closed:
        return _conn
    if not settings.database_url:
        raise ValueError("DATABASE_URL is not set in .env")
    
    conn = psycopg2.connect(settings.database_url, cursor_factory=RealDictCursor)
    conn.autocommit = False
    
    try:
        register_vector(conn)
    except psycopg2.ProgrammingError:
        pass
        
    _conn = conn
    migrate(conn)
    log.info("db connected to Supabase")
    return conn


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
            with _lock:
                cur.execute(script)
                cur.execute("INSERT INTO schema_version (version) VALUES (%s) ON CONFLICT (version) DO NOTHING", (i + 1,))
                conn.commit()
                
        try:
            register_vector(conn)
        except psycopg2.ProgrammingError:
            pass


def close() -> None:
    global _conn
    if _conn is not None:
        if not _conn.closed:
            _conn.close()
        _conn = None


def _write(sql: str, params: tuple = ()) -> psycopg2.extensions.cursor:
    conn = connect()
    with _lock:
        with conn.cursor() as cur:
            # psycopg2 uses %s for placeholders instead of ?
            cur.execute(sql.replace("?", "%s"), params)
        conn.commit()
        return cur


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = connect()
    with _lock:
        with conn.cursor() as cur:
            cur.execute(sql.replace("?", "%s"), params)
            return [dict(r) for r in cur.fetchall()]


def _row(sql: str, params: tuple = ()) -> dict | None:
    conn = connect()
    with _lock:
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
) -> dict:
    _write(
        """INSERT INTO plans (id, user_id, created_at, course, week_label, unit, query, plan_json,
                              docx_path, retrieved_ids, warnings, chat_id, template)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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


def list_plans(user_id: str, *, limit: int = 50, offset: int = 0, q: str | None = None) -> dict:
    where, params = "WHERE user_id = ?", [user_id]
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
    allowed = {"plan_json", "week_label", "unit", "docx_path", "warnings", "course"}
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
