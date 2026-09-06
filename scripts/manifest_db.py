"""Thin helper around `public.standards_frameworks` — the manifest of what
each state's standards *should* be, and where each (state, course) pair
stands in the ingest → gate → activate pipeline. Shared by the fetch and
gate scripts so they read/write one source of truth instead of each
re-deriving connection/query logic.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import psycopg2
from psycopg2.extras import RealDictCursor

from backend.db import _dsn_with_tls


def _connect():
    return psycopg2.connect(_dsn_with_tls(), cursor_factory=RealDictCursor)


def get_frameworks(state: str) -> list[dict[str, Any]]:
    """Every manifest row for a state, in course order."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select * from public.standards_frameworks where state = %s order by course",
            (state,),
        )
        return list(cur.fetchall())


def get_framework(state: str, course: str) -> dict[str, Any] | None:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select * from public.standards_frameworks where state = %s and course = %s",
            (state, course),
        )
        return cur.fetchone()


def update_framework(state: str, course: str, **fields: Any) -> None:
    """Merge `fields` into one manifest row. Always bumps `updated_at`."""
    if not fields:
        return
    fields = {**fields, "updated_at": "now()"}
    set_clause = ", ".join(
        f"{col} = now()" if val == "now()" else f"{col} = %s" for col, val in fields.items()
    )
    values = [val for val in fields.values() if val != "now()"]
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"update public.standards_frameworks set {set_clause} where state = %s and course = %s",
            (*values, state, course),
        )
        conn.commit()
