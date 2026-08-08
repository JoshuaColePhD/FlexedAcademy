"""Lesson-plan generation, including the SSE stream."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db, llm, service
from ..config import settings
from ..deps import get_current_user
from ..entitlement import entitlement
from ..errors import AppError
from ..schema import SchemaError

log = logging.getLogger("aplang.generate")
router = APIRouter(prefix="/api", tags=["generate"])


class GenerateRequest(BaseModel):
    query: str = Field(min_length=1, max_length=settings.max_query_chars)
    chat_id: str | None = None

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatStreamRequest(BaseModel):
    messages: list[ChatMessage]
    mode: str = "brainstorm" # can be 'interview', 'standards', etc.


class ReviseDayRequest(BaseModel):
    plan_id: str = Field(min_length=1, max_length=64)
    day_index: int = Field(ge=0, le=4)
    feedback: str = Field(min_length=1, max_length=4000)
    # Additive and backward compatible: absent means "regenerate the whole day",
    # which is what every existing caller sends. Present means in-cell tweaking
    # — one key rewritten, siblings untouched. Membership is checked in
    # service.revise_day rather than by a Literal here, so the allowed set has
    # exactly one definition (schema.REVISABLE_FIELDS) and the rejection arrives
    # as the app's own {code,message,hint} envelope rather than a 422.
    field: str | None = None


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"



def _require_entitlement(user_id: str) -> None:
    """The paywall, in one place, on the only two doors that make a new week.

    Revising is deliberately NOT gated. "A week free" means a week of lesson
    plans; a teacher fixing Thursday is still working on the week they already
    have, and taking that away would make the free week a demo rather than a
    thing they can actually use. Downloads are never gated at all.
    """
    ent = entitlement(user_id)
    if ent.may_generate:
        return
    raise AppError(
        "subscription_required",
        "You’ve used your free week. Subscribe to keep building.",
        status=402,
        hint="Everything you’ve already built stays yours — open it, revise it, download it.",
        extra={"entitlement": ent.as_dict()},
    )


@router.post("/generate")
def generate(req: GenerateRequest, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    _require_entitlement(user_id)
    return service.generate(user_id, req.query, chat_id=req.chat_id, bg_tasks=bg_tasks)


@router.post("/generate_stream")
def generate_stream(req: GenerateRequest, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    """Stream tokens, then emit the finished plan.

    Every terminal event carries an `error` object with the same {code, message,
    hint} shape as the REST errors, so the client has one path for both.
    """
    # Before the stream opens, so a blocked request is an ordinary 402 with the
    # normal error envelope rather than an SSE frame the reader has to special-
    # case. useLessonStream already reads a non-200 body through apiErrorFromBody.
    _require_entitlement(user_id)

    def event_stream():
        chunks: list[str] = []
        try:
            result = service.prepare(user_id, req.query)
            yield _sse(
                {
                    "grounding": {
                        "codes": sorted(result.codes),
                        "thin": result.thin,
                        "count": len(result.chunks),
                        "floor": result.floor,
                    }
                }
            )
            for delta in llm.stream_plan(user_id, req.query, result):
                chunks.append(delta)
                yield _sse({"chunk": delta})

            from ..schema import loads_lenient

            row = service.finalize(
                user_id=user_id,
                plan_raw=loads_lenient("".join(chunks)),
                query=req.query,
                result=result,
                chat_id=req.chat_id,
                bg_tasks=bg_tasks,
            )
            yield _sse(
                {
                    "done": True,
                    "plan_id": row["id"],
                    "plan": row["plan_json"],
                    "warnings": row["warnings"],
                    "week_label": row["week_label"],
                    "unit": row["unit"],
                }
            )
        except (AppError, SchemaError) as e:
            log.warning("stream failed code=%s", e.code)
            yield _sse({"error": e.payload().get("error", e.payload())})
        except Exception as e:  # noqa: BLE001 - last resort, still must reach the client
            log.exception("stream crashed")
            yield _sse(
                {
                    "error": {
                        "code": "internal_error",
                        "message": "The server crashed while generating the plan.",
                    }
                }
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        background=bg_tasks,
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.post("/chat_stream")
def chat_stream(req: ChatStreamRequest, user_id: str = Depends(get_current_user)):
    """Stream a standard conversational response, not a JSON schema."""

    def event_stream():
        try:
            # We construct a system prompt based on the user's settings and chosen mode.
            s = db.get_settings_row(user_id)
            subject = s.get("subject", "AP Language & Composition")
            grade = s.get("grade", "11")
            
            system_prompt = (
                f"You are an expert curriculum brainstorming assistant for {subject} (Grade {grade}). "
                "The teacher is preparing to generate or revise a weekly lesson plan. "
            )
            
            if req.mode == "interview":
                system_prompt += (
                "Your job is to INTERVIEW the teacher to figure out what they want to teach. "
                "Ask inquisitive, guiding questions one at a time. Be conversational, exactly like Claude does when asked to interview a user. "
                "When you have enough information to build the 5-day week, call the `generate_lesson_plan` tool."
                )
            elif req.mode == "standards":
                system_prompt += (
                    "Your job is to help the teacher find the perfect academic standards for their upcoming week. "
                    "Suggest broad topics and narrow down what standards they should focus on. "
                    "When they are ready to build the plan, call the `generate_lesson_plan` tool."
                )
            else:
                system_prompt += (
                    "Have a natural back-and-forth conversation to brainstorm ideas for their upcoming week, or discuss revisions to an existing week. "
                    "Keep your responses concise and helpful. "
                    "When you have enough information and the user is ready to build or revise the plan, call the `generate_lesson_plan` tool."
                )
            
            messages = [{"role": "system", "content": system_prompt}]
            messages.extend([{"role": msg.role, "content": msg.content} for msg in req.messages])
            
            for event in llm.stream_chat(messages):
                yield _sse(event)
                
            yield _sse({"done": True})
        except Exception as e:
            log.exception("chat stream crashed")
            yield _sse({
                "error": {
                    "code": "internal_error",
                    "message": "Chat generation failed unexpectedly.",
                    "hint": str(e)[:200],
                }
            })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.post("/revise_day")
def revise_day(req: ReviseDayRequest, user_id: str = Depends(get_current_user)):
    """Rewrite one day — or one cell of it — AND rebuild the .docx, so the file
    matches what's on screen."""
    return service.revise_day(user_id, req.plan_id, req.day_index, req.feedback, req.field)


@router.post("/chats/{chat_id}/messages")
def add_message(chat_id: str, body: dict, user_id: str = Depends(get_current_user)):
    role = body.get("role")
    if role not in ("user", "assistant", "system"):
        raise AppError("bad_role", f"Unknown message role {role!r}.", status=400)
    if not db.get_chat(user_id, chat_id):
        raise AppError("chat_not_found", "No such chat.", status=404)
    return db.add_message(chat_id, role, str(body.get("content") or ""), body.get("plan_id"))
