"""Teacher-owned coaching context and memory controls."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import db
from ..deps import get_current_user
from ..errors import AppError

router = APIRouter(prefix="/api/coaching", tags=["coaching"])


class CoachingProfileBody(BaseModel):
    teaching_context: str = Field(default="", max_length=2000)
    strengths: str = Field(default="", max_length=2000)
    challenges: str = Field(default="", max_length=2000)
    preferences: str = Field(default="", max_length=2000)
    goals: str = Field(default="", max_length=2000)


@router.get("/profile")
def get_profile(user_id: str = Depends(get_current_user)):
    return db.get_coaching_profile(user_id)


@router.patch("/profile")
def update_profile(body: CoachingProfileBody, user_id: str = Depends(get_current_user)):
    return db.upsert_coaching_profile(user_id, body.model_dump())


@router.get("/memories")
def list_memories(user_id: str = Depends(get_current_user)):
    return {"items": db.list_coaching_memories(user_id)}


@router.delete("/memories/{memory_id}")
def delete_memory(memory_id: str, user_id: str = Depends(get_current_user)):
    if not db.delete_coaching_memory(user_id, memory_id):
        raise AppError("memory_not_found", "That coaching memory no longer exists.", status=404)
    return {"ok": True}
