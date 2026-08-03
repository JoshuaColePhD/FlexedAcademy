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
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings

log = logging.getLogger("aplang.db")

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()

MIGRATIONS: list[str] = [
    # v1 — initial
    """
    CREATE TABLE settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      teacher    TEXT NOT NULL DEFAULT 'Josh Cole',
      course     TEXT NOT NULL DEFAULT 'AP Language & Composition',
      period     TEXT NOT NULL DEFAULT '3rd period',
      updated_at TEXT NOT NULL
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
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content    TEXT NOT NULL,
      plan_id    TEXT REFERENCES plans(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_messages_chat ON messages(chat_id, id);
    """,
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def connect() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn
    path = Path(settings.app_db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    _conn = conn
    migrate(conn)
    log.info("db ready at %s", path)
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i, script in enumerate(MIGRATIONS[version:], start=version):
        log.info("applying migration %d", i + 1)
        with _lock:
            conn.executescript(script)
            conn.execute(f"PRAGMA user_version = {i + 1}")
            conn.commit()


def close() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


def _write(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    conn = connect()
    with _lock:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur


def _rows(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return connect().execute(sql, params).fetchall()


def _row(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    return connect().execute(sql, params).fetchone()


# ---------------------------------------------------------------------------
# Settings (singleton)
# ---------------------------------------------------------------------------

DEFAULT_SETTINGS = {
    "teacher": "Josh Cole",
    "course": "AP Language & Composition",
    "period": "3rd period",
}


def get_settings_row() -> dict:
    row = _row("SELECT * FROM settings WHERE id = 1")
    if row is None:
        _write(
            "INSERT INTO settings (id, teacher, course, period, updated_at) VALUES (1,?,?,?,?)",
            (
                DEFAULT_SETTINGS["teacher"],
                DEFAULT_SETTINGS["course"],
                DEFAULT_SETTINGS["period"],
                now(),
            ),
        )
        row = _row("SELECT * FROM settings WHERE id = 1")
    return dict(row)  # type: ignore[arg-type]


def update_settings(teacher: str, course: str, period: str) -> dict:
    get_settings_row()  # ensure the row exists
    _write(
        "UPDATE settings SET teacher=?, course=?, period=?, updated_at=? WHERE id = 1",
        (teacher, course, period, now()),
    )
    return get_settings_row()


# ---------------------------------------------------------------------------
# Plans
# ---------------------------------------------------------------------------


def create_plan(
    *,
    plan_id: str,
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
        """INSERT INTO plans (id, created_at, course, week_label, unit, query, plan_json,
                              docx_path, retrieved_ids, warnings, chat_id, template)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            plan_id,
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
    return get_plan(plan_id)  # type: ignore[return-value]


def _hydrate_plan(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["plan_json"] = json.loads(d["plan_json"]) if d.get("plan_json") else None
    d["retrieved_ids"] = json.loads(d["retrieved_ids"]) if d.get("retrieved_ids") else []
    d["warnings"] = json.loads(d["warnings"]) if d.get("warnings") else []
    d["has_docx"] = bool(d.get("docx_path")) and Path(d["docx_path"]).is_file()
    return d


def get_plan(plan_id: str) -> dict | None:
    row = _row("SELECT * FROM plans WHERE id = ?", (plan_id,))
    return _hydrate_plan(row) if row else None


def list_plans(*, limit: int = 50, offset: int = 0, q: str | None = None) -> dict:
    where, params = "", []
    if q:
        where = "WHERE week_label LIKE ? OR query LIKE ? OR unit LIKE ?"
        like = f"%{q}%"
        params = [like, like, like]

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


def update_plan(plan_id: str, **fields: Any) -> dict | None:
    allowed = {"plan_json", "week_label", "unit", "docx_path", "warnings", "course"}
    sets, params = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        sets.append(f"{k} = ?")
        params.append(json.dumps(v) if k in ("plan_json", "warnings") else v)
    if sets:
        params.append(plan_id)
        _write(f"UPDATE plans SET {', '.join(sets)} WHERE id = ?", tuple(params))
    return get_plan(plan_id)


def delete_plan(plan_id: str) -> bool:
    return _write("DELETE FROM plans WHERE id = ?", (plan_id,)).rowcount > 0


# ---------------------------------------------------------------------------
# Chats & messages
# ---------------------------------------------------------------------------


def create_chat(title: str, chat_id: str | None = None) -> dict:
    cid = chat_id or new_id()
    ts = now()
    _write(
        "INSERT OR IGNORE INTO chats (id, title, created_at, updated_at) VALUES (?,?,?,?)",
        (cid, title[:200], ts, ts),
    )
    return get_chat(cid)  # type: ignore[return-value]


def get_chat(chat_id: str, with_messages: bool = False) -> dict | None:
    row = _row("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if not row:
        return None
    chat = dict(row)
    if with_messages:
        chat["messages"] = list_messages(chat_id)
    return chat


def list_chats(limit: int = 100) -> list[dict]:
    return [dict(r) for r in _rows("SELECT * FROM chats ORDER BY updated_at DESC LIMIT ?", (limit,))]


def rename_chat(chat_id: str, title: str) -> dict | None:
    _write("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?", (title[:200], now(), chat_id))
    return get_chat(chat_id)


def delete_chat(chat_id: str) -> bool:
    return _write("DELETE FROM chats WHERE id = ?", (chat_id,)).rowcount > 0


def add_message(chat_id: str, role: str, content: str, plan_id: str | None = None) -> dict:
    cur = _write(
        "INSERT INTO messages (chat_id, role, content, plan_id, created_at) VALUES (?,?,?,?,?)",
        (chat_id, role, content, plan_id, now()),
    )
    _write("UPDATE chats SET updated_at = ? WHERE id = ?", (now(), chat_id))
    return {
        "id": cur.lastrowid,
        "chat_id": chat_id,
        "role": role,
        "content": content,
        "plan_id": plan_id,
    }


def list_messages(chat_id: str) -> list[dict]:
    return [
        dict(r)
        for r in _rows("SELECT * FROM messages WHERE chat_id = ? ORDER BY id", (chat_id,))
    ]


def import_chats(payload: list[dict]) -> dict:
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
        create_chat(str(chat.get("title") or "Imported chat"), chat_id=cid)
        for msg in chat.get("messages") or []:
            role = msg.get("role")
            if role not in ("user", "assistant", "system"):
                continue
            add_message(cid, role, str(msg.get("content") or ""))
        imported += 1
    return {"imported": imported, "skipped": skipped}
