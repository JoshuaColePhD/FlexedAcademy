"""The daily warm-up companion.

A lesson plan's own `do_now` field (schema.py's DAY_JSON_SCHEMA) already
covers bell-ringers for any day that HAS a built plan — see TodayPage on
the frontend, which reads that field straight off the existing plan for
days a week already exists. This endpoint is for the gap that leaves: a
day with no plan yet, which is most days, most weeks, for most teachers.
Meant to be opened daily even when nothing's been planned — the free
"quick win" that brings a teacher back before their next real planning
session, not a replacement for one.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import llm
from ..deps import get_current_user

router = APIRouter(prefix="/api", tags=["bell_ringer"])


class BellRingerRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=120)
    grade: str = Field(min_length=1, max_length=20)
    topic: str | None = Field(default=None, max_length=200)


@router.post("/bell_ringer")
def bell_ringer(req: BellRingerRequest, user_id: str = Depends(get_current_user)):
    """Not gated by require_entitlement — same reasoning as /decisions
    (routes/generate.py): a single cheap, low-stakes suggestion standing in
    for a real plan, not a plan generation in its own right. Usage is still
    recorded (see llm.generate_bell_ringer) so it isn't a free, unmetered
    channel, just not one the weekly cap blocks."""
    return llm.generate_bell_ringer(user_id, req.subject, req.grade, req.topic)
