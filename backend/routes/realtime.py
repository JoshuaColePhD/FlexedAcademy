"""The live speech-to-speech voice session — a persistent WebRTC connection
straight from the browser to OpenAI's Realtime API, instead of the
record-clip -> Whisper -> chat-completion -> tts-1 cascade the rest of this
app's voice mode still uses (see generate.py's chat_stream and llm.py's
transcribe/synthesize_speech, both still used by typed-chat dictation and
the text chat path — this is additive, not a replacement).

This backend never sees the teacher's audio. Its only job is minting a
short-lived credential (an OpenAI "ephemeral client secret") pre-configured
with this conversation's system prompt and tools, so the browser can open
the WebRTC connection directly against OpenAI without our permanent API key
ever reaching client code. See VoiceProvider... actually see
frontend/src/lib/realtimeVoice.js for the client side of this handshake.

Known v1 limitation, called out here rather than silently: chat_stream's
map_context_for() RAG lookup grounds the conversation in the teacher's own
uploaded pacing guide, keyed on their latest message — a realtime session
has no "latest message" yet at the moment these instructions are set, so
that grounding doesn't happen here. Revisit as a live tool call
(model-initiated, mid-session) if it turns out to matter in practice.
"""
from __future__ import annotations

import logging

import requests
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import db, llm
from ..config import settings
from ..deps import get_current_user
from ..entitlement import require_entitlement
from ..errors import AppError
from .generate import build_system_prompt, resolve_conversation_context

log = logging.getLogger("aplang.realtime")
router = APIRouter(prefix="/api/realtime", tags=["realtime"])

_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
# A live conversational turn, not a bulk API call — 10s comfortably covers a
# slow response from OpenAI's own auth/session-config path without leaving a
# teacher who just tapped "start talking" staring at a spinner far longer
# than the rest of this app ever makes them wait for anything.
_REQUEST_TIMEOUT_S = 10.0


class RealtimeSessionRequest(BaseModel):
    mode: str = "brainstorm"
    chat_id: str | None = None
    week_number: int | None = None


@router.post("/session")
def create_session(req: RealtimeSessionRequest, user_id: str = Depends(get_current_user)):
    """Mint an ephemeral client secret pre-loaded with this conversation's
    system prompt and tools. The frontend uses the returned value directly
    as the bearer token for the WebRTC SDP exchange — see
    https://api.openai.com/v1/realtime/calls in realtimeVoice.js.

    Gated by require_entitlement the same as chat_stream: a live voice
    session is exactly the kind of real token spend this exists to cap, and
    unlike chat_stream's per-turn HTTP call, the only gate a persistent
    session gets is right here, at the moment it's opened.
    """
    require_entitlement(user_id)

    ctx = resolve_conversation_context(user_id, req.chat_id, req.week_number)
    instructions = build_system_prompt(ctx, req.mode, voice=True)

    if not settings.has_api_key:
        raise AppError(
            "no_api_key",
            "OPENAI_API_KEY is not set.",
            hint="Add it to the .env file at the project root (see .env.example).",
        )

    try:
        resp = requests.post(
            _CLIENT_SECRETS_URL,
            headers={
                "Authorization": f"Bearer {settings.openai_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "session": {
                    "type": "realtime",
                    "model": settings.realtime_model,
                    "instructions": instructions,
                    "output_modalities": ["audio"],
                    "audio": {
                        "output": {"voice": settings.realtime_voice},
                        # Transcribing the teacher's own speech server-side is
                        # what lets the client show the same "you said" echo
                        # (VoiceModePanel's heardText) the old Whisper-based
                        # pipeline gave for free as a side effect of
                        # transcribing before ever calling the chat model.
                        "input": {"transcription": {"model": "whisper-1"}},
                    },
                    "tools": llm.realtime_tool_defs(),
                    "tool_choice": "auto",
                    # Server-side VAD replaces VoiceModePanel's client-side
                    # energy-threshold endpointing (SILENCE_MS=620ms) and its
                    # separate, stricter barge-in threshold — the server
                    # detects both start-of-speech (interrupting whatever is
                    # currently playing) and end-of-speech on its own.
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500,
                        "interrupt_response": True,
                        "create_response": True,
                    },
                },
            },
            timeout=_REQUEST_TIMEOUT_S,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        log.warning("realtime session mint failed: %s", e)
        raise AppError(
            "realtime_session_failed",
            "Couldn't start a live voice session.",
            status=502,
            hint="Try again in a moment.",
        ) from e

    data = resp.json()
    return {
        "client_secret": data.get("value"),
        "expires_at": data.get("expires_at"),
        "model": settings.realtime_model,
    }


class RealtimeUsageRequest(BaseModel):
    """Client-reported usage off a session's response.done events.

    Everywhere else in this app, db.record_usage runs on the SAME machine
    that made the OpenAI call (see llm.py), so there's nothing to trust —
    the number IS what was spent. A realtime session is different: the
    browser talks to OpenAI directly, so this backend never sees the
    response objects those calls produce, and the token counts below are
    only as honest as the client reporting them. Sanity-capped, not
    verified — a teacher's own browser under-reporting its own usage cap
    isn't a threat model this app defends against anywhere else either
    (there's no server-side metering of tokens actually consumed by a
    single chat_stream call vs. what get billed either), but an open
    upload endpoint without SOME ceiling is worth avoiding regardless.
    """

    input_tokens: int = Field(ge=0, le=200_000)
    output_tokens: int = Field(ge=0, le=200_000)


@router.post("/usage")
def report_usage(req: RealtimeUsageRequest, user_id: str = Depends(get_current_user)):
    db.record_usage(user_id, "realtime_voice", req.input_tokens, req.output_tokens)
    return {"ok": True}
