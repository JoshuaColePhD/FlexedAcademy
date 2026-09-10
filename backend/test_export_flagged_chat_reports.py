"""The export script's parser must round-trip what POST /api/chat/flag writes.

Kept in backend/ (not scripts/) so it runs with the rest of the hermetic
suite — it imports scripts/export_flagged_chat_reports.py directly rather
than duplicating its parsing logic, so a change to either side breaks this
test instead of silently drifting apart.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from backend.routes.misc import FlagChatMessageBody, _flag_message_body

_SPEC = importlib.util.spec_from_file_location(
    "export_flagged_chat_reports",
    Path(__file__).resolve().parent.parent / "scripts" / "export_flagged_chat_reports.py",
)
export_script = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = export_script
_SPEC.loader.exec_module(export_script)


def test_section_round_trips_every_field():
    body = _flag_message_body(FlagChatMessageBody(
        chat_id="chat42",
        message_content="Week uses RL.9-10.99, which is not a real code.",
        context="Plan a week on close reading of a short story.",
        note="This standard code looks made up.",
    ))
    assert export_script._section(body, "Chat") == "chat42"
    assert export_script._section(body, "Teacher's request") == "Plan a week on close reading of a short story."
    assert export_script._section(body, "Flagged response") == "Week uses RL.9-10.99, which is not a real code."
    assert export_script._section(body, "Teacher's note") == "This standard code looks made up."


def test_section_is_empty_for_omitted_optional_fields():
    body = _flag_message_body(FlagChatMessageBody(message_content="Some unhelpful reply."))
    assert export_script._section(body, "Chat") == ""
    assert export_script._section(body, "Teacher's request") == ""
    assert export_script._section(body, "Teacher's note") == ""
    # The last section in the body (no trailing "\n\n" to bound it) must
    # still parse to the end of the string, not come back empty.
    assert export_script._section(body, "Flagged response") == "Some unhelpful reply."


def test_report_from_thread_shapes_admin_replies():
    thread = {
        "id": "t1",
        "status": "open",
        "created_at": "2026-09-10T00:00:00Z",
        "teacher_name": "Ms. Rivera",
        "teacher_email": "rivera@example.com",
        "messages": [
            {"author_type": "teacher", "body": "Chat: chat1\n\nFlagged response:\nBad answer."},
            {"author_type": "admin", "body": "Looked into it, fixing now."},
        ],
    }
    report = export_script._report_from_thread(thread)
    assert report["thread_id"] == "t1"
    assert report["flagged_response"] == "Bad answer."
    assert report["admin_replies"] == ["Looked into it, fixing now."]
