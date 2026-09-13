"""Pull every teacher-flagged AI response out of the support inbox as one file.

A flagged reply (see routes/misc.py's POST /api/chat/flag) lands as an
ordinary support thread with subject "Flagged AI response" — deliberately, so
it needs no new admin surface. That's the right place for a human to see it
and reply, but it is a poor place to review the *population* of flagged
replies: they're mixed in with billing questions and password resets, one
thread per click, with no way to tell "already turned into a regression test"
from "still needs a look."

This script is the other half of that loop: dump every flagged thread to one
JSON file for offline review, so promoting a genuine bug into a permanent
regression test (a new case in backend/test_chat_*.py or eval/, following
this repo's existing convention of one test per fixed bug) is a five-minute
job instead of an archaeology exercise. It does not delete or resolve
anything in the support inbox — replying/resolving there is unaffected.

Needs a real DATABASE_URL (the same one the deployed app uses) and admin-level
access, same as any other script in this directory that reads production data.

Usage:
    ./venv/bin/python scripts/export_flagged_chat_reports.py
    ./venv/bin/python scripts/export_flagged_chat_reports.py --out /tmp/flagged.json
    ./venv/bin/python scripts/export_flagged_chat_reports.py --since 2026-09-01
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import db
from backend.routes.misc import FLAGGED_CHAT_SUBJECT

DEFAULT_OUT = PROJECT_ROOT / "flagged_chat_reports.json"


def _section(body: str, label: str) -> str:
    """Pull one labeled section back out of the body POST /api/chat/flag wrote.

    The body is assembled from a fixed, ordered list of "Label: text" /
    "Label:\\ntext" blocks (see misc.py's `_flag_message_body` — "Chat" uses
    an inline space, the multi-line fields a newline) — not a structured
    payload — so this parses it back apart the same way rather than
    duplicating that assembly logic here. Missing sections (an optional
    note, no chat_id) are normal.
    """
    marker = f"{label}:"
    start = body.find(marker)
    if start < 0:
        return ""
    start = len(marker) + start
    # Sections are joined with "\n\n" by the writer; "Chat: x" and
    # "Label:\ntext" both leave exactly one leading space/newline to strip.
    start += 1
    # Sections are joined with "\n\n" by the writer, so the next section
    # starts after the first blank line; a label with no trailing text (the
    # last section) runs to the end of the body instead.
    end = body.find("\n\n", start)
    return body[start:end if end >= 0 else len(body)].strip()


def _report_from_thread(thread: dict) -> dict:
    first_message = thread["messages"][0]["body"] if thread.get("messages") else ""
    return {
        "thread_id": thread["id"],
        "status": thread["status"],
        "created_at": thread["created_at"],
        "teacher_name": thread.get("teacher_name"),
        "teacher_email": thread.get("teacher_email"),
        "chat_id": _section(first_message, "Chat") or None,
        "teachers_request": _section(first_message, "Teacher's request"),
        "flagged_response": _section(first_message, "Flagged response"),
        "teachers_note": _section(first_message, "Teacher's note") or None,
        "admin_replies": [
            m["body"] for m in thread.get("messages", [])[1:]
            if m.get("author_type") == "admin"
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output path (default: {DEFAULT_OUT})")
    ap.add_argument("--since", type=str, default=None, help="only threads created on/after this ISO date (e.g. 2026-09-01)")
    args = ap.parse_args()

    with db.as_support_admin():
        threads = [t for t in db.list_admin_support_threads() if t["subject"] == FLAGGED_CHAT_SUBJECT]
        if args.since:
            threads = [t for t in threads if str(t["created_at"]) >= args.since]
        reports = [_report_from_thread(db.get_admin_support_thread(t["id"])) for t in threads]

    args.out.write_text(json.dumps({
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "count": len(reports),
        "reports": reports,
    }, indent=2))

    print(f"Wrote {len(reports)} flagged report(s) to {args.out}")
    unresolved = [r for r in reports if not r["admin_replies"]]
    if unresolved:
        print(f"{len(unresolved)} have no admin reply yet:")
        for r in unresolved:
            preview = r["flagged_response"][:70].replace("\n", " ")
            print(f"  {r['thread_id']}  {r['created_at']}  {preview}...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
