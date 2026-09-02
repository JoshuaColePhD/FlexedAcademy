"""Provision the optional read-only recruiter showcase account."""
from __future__ import annotations

import copy
import json
import logging

from . import auth, db
from .config import PROJECT_ROOT, settings

log = logging.getLogger("flexedacademy.demo")

DEMO_CLASS_ID = "recruiter_demo_class"
DEMO_CHAT_ID = "recruiter_demo_chat"
DEMO_PLAN_ID = "recruiter_demo_plan"


def ensure_demo_account() -> dict | None:
    """Provision the account and deterministic sample records when enabled."""
    if not settings.demo_account_enabled:
        return None

    user = db.ensure_demo_user(
        user_id=settings.demo_account_id,
        email=settings.demo_account_email,
        name=settings.demo_account_name,
        password_hash=auth.hash_password(settings.demo_account_password),
    )
    _ensure_sample_content(user)
    log.info("read-only recruiter demo account is ready (%s)", user["email"])
    return db.get_user_by_id(user["id"])


def _ensure_sample_content(user: dict) -> None:
    user_id = user["id"]
    teacher = user["name"]
    now = db.now()

    # Keep the showcase stable across restarts instead of creating a new UUID
    # and a duplicate class every time the deployment boots.
    db._write(
        """
        INSERT INTO classes
          (id, user_id, name, subject, grade, state, school, sort_order, archived, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        ON CONFLICT (id) DO UPDATE SET
          user_id = excluded.user_id, name = excluded.name,
          subject = excluded.subject, grade = excluded.grade,
          school = excluded.school, archived = 0
        """,
        (
            DEMO_CLASS_ID,
            user_id,
            "AP Language & Composition",
            "AP_Lang",
            "11",
            None,
            "generic",
            now,
        ),
    )
    db.update_settings(
        user_id,
        teacher,
        "AP Language & Composition",
        "3rd period",
        "AP_Lang",
        "11",
    )

    chat = db.create_chat(
        user_id,
        "Week 02 · Rhetorical analysis",
        chat_id=DEMO_CHAT_ID,
        class_id=DEMO_CLASS_ID,
        week_number=2,
    )

    if not db.get_plan(user_id, DEMO_PLAN_ID):
        source_path = PROJECT_ROOT / "backend" / "builder" / "example-week.json"
        with source_path.open(encoding="utf-8") as source:
            plan_json = copy.deepcopy(json.load(source))
        plan_json["teacher"] = teacher
        db.create_plan(
            plan_id=DEMO_PLAN_ID,
            user_id=user_id,
            course="AP Language & Composition",
            week_label=plan_json["week_of"],
            unit="Rhetorical analysis",
            query="Build a standards-grounded AP Language week on rhetorical analysis.",
            plan_json=plan_json,
            docx_path=str(PROJECT_ROOT / "docs" / "recruiter" / "FlexedAcademy_Sample_Lesson_Plan.docx"),
            retrieved_ids=[
                "AP_Lang:11:2.A",
                "AP_Lang:11:2.B",
                "AP_Lang:11:4.A",
                "AP_Lang:11:4.C",
                "AP_Lang:11:6.A",
            ],
            warnings=[],
            chat_id=chat["id"],
            template="florence-docx-v2",
            class_id=DEMO_CLASS_ID,
            week_number=2,
        )

    # Fixed client ids make this safe to run at every application startup.
    db.add_message(
        DEMO_CHAT_ID,
        "user",
        "Build a week on rhetorical analysis with grounded AP standards.",
        client_id="recruiter-demo-user-request",
    )
    db.add_message(
        DEMO_CHAT_ID,
        "assistant",
        "Built a sample Week 02 plan. Review the cited standards, grounding details, and downloadable artifact.",
        plan_id=DEMO_PLAN_ID,
        client_id="recruiter-demo-assistant-response",
    )
