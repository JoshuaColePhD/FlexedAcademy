"""Shared, teacher-approved passage/question sets.

The library deliberately stores a self-contained assessment set rather than
only individual questions: a passage and its multiple-choice items need to
travel together to remain answerable when another teacher reuses them.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from . import schema

_SENSITIVE_PATTERNS = (
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
    re.compile(r"\b(?:student|pupil|child)\s+(?:name|id|number)\s*[:#-]?\s*[^\n,;]+", re.IGNORECASE),
    re.compile(r"\b(?:ssn|social security|student id|school id)\s*[:#-]?\s*[A-Z0-9-]+\b", re.IGNORECASE),
)


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def content_hash(quiz_json: dict) -> str:
    """Stable identity for duplicate detection across teachers."""
    passages = quiz_json.get("passages") or []
    questions = quiz_json.get("questions") or []
    canonical = {
        "passages": [
            {"title": normalize_text(p.get("title")), "text": normalize_text(p.get("text"))}
            for p in passages if isinstance(p, dict)
        ],
        "questions": [
            {
                "passage_id": normalize_text(q.get("passage_id")),
                "prompt": normalize_text(q.get("prompt")),
                "choices": [normalize_text(c) for c in (q.get("choices") or [])],
                "correct_index": q.get("correct_index"),
            }
            for q in questions if isinstance(q, dict) and q.get("type") == "multiple_choice"
        ],
    }
    raw = json.dumps(canonical, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def sensitive_content(quiz_json: dict) -> bool:
    text = json.dumps(quiz_json, ensure_ascii=False)
    return any(pattern.search(text) for pattern in _SENSITIVE_PATTERNS)


def passages_for_library(quiz_json: dict) -> list[dict]:
    return [
        p for p in (quiz_json.get("passages") or [])
        if isinstance(p, dict) and normalize_text(p.get("text"))
    ]


def library_questions(quiz_json: dict) -> list[dict]:
    return [
        q for q in (quiz_json.get("questions") or [])
        if isinstance(q, dict)
        and q.get("type") == "multiple_choice"
        and normalize_text(q.get("passage_id"))
    ]


def standards_from_plan(plan: dict) -> list[str]:
    """Extract code-shaped tokens from the plan for hard library filtering."""
    found: set[str] = set()
    for day in (plan.get("days") or []):
        if not isinstance(day, dict):
            continue
        text = " ".join(str(day.get(field) or "") for field in ("standards", "act_alignment"))
        found.update(re.findall(r"\b[A-Z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+\b", text))
        found.update(re.findall(r"\b[A-Z]{2,}\s+\d{3}\b", text))
    return sorted(found)


def context_values(*, plan: dict, quiz_json: dict, subject: str, grade: str) -> dict:
    standards = sorted({
        normalize_text(q.get("standard_code"))
        for q in (quiz_json.get("questions") or [])
        if isinstance(q, dict) and normalize_text(q.get("standard_code"))
    })
    topic = normalize_text(plan.get("course") or plan.get("unit") or plan.get("week_of"))
    return {
        "course": normalize_text(plan.get("course") or subject),
        "subject": normalize_text(subject),
        "grade": normalize_text(grade),
        "standard_codes": standards,
        "context_text": normalize_text(" | ".join([topic, *standards])),
    }


def validate_publishable(quiz_json: dict, *, source: str, approved: bool) -> list[str]:
    """Return publish-blocking reasons; publishing is always explicit."""
    reasons: list[str] = []
    passages = passages_for_library(quiz_json)
    questions = library_questions(quiz_json)
    if source not in ("ai_generated", "teacher_provided", "shared_library"):
        reasons.append("Unknown passage source.")
    if not passages:
        reasons.append("A shared item needs at least one passage.")
    if not questions:
        reasons.append("A shared item needs at least one passage-linked multiple-choice question.")
    if sensitive_content(quiz_json):
        reasons.append("The passage or questions appear to contain personal or student-identifying information.")
    return reasons


def reusable_quiz_json(row: dict) -> dict:
    """Copy the stored set without creator-only fields."""
    payload = row.get("quiz_json") or {}
    questions = []
    for q in payload.get("questions") or []:
        if not isinstance(q, dict) or q.get("type") != "multiple_choice":
            continue
        questions.append(dict(q))
    return {
        "title": payload.get("title") or row.get("title") or "Shared passage set",
        "passages": [dict(p) for p in (payload.get("passages") or []) if isinstance(p, dict)],
        "questions": questions,
    }


def alignment_summary(quiz_json: dict) -> dict:
    blooms: list[str] = []
    doks: list[int] = []
    for q in (quiz_json.get("questions") or []):
        alignment = q.get("alignment") or {}
        if alignment.get("bloom") in schema.BLOOM_LEVELS:
            blooms.append(alignment["bloom"])
        if alignment.get("dok") in schema.DOK_LEVELS:
            doks.append(alignment["dok"])
    return {"blooms": sorted(set(blooms)), "doks": sorted(set(doks))}
