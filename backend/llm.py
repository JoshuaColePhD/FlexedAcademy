"""OpenAI calls, using Structured Outputs so JSON shape stops being a gamble.

`response_format={"type": "json_schema", "strict": True}` removes an entire class
of bug the old code handled by hoping: markdown fences (stripped in four
separate copy-pasted places), missing keys, and `engagement_strategy` arriving as
a comma string instead of a list.

What strict mode does NOT give us, and why validate_plan() is still mandatory:
minItems/maxItems are unsupported, so "exactly five days, correctly named" is not
expressible in the schema. That check lives in schema.py.
"""
from __future__ import annotations

import functools
import json
import logging
from collections.abc import Iterator

from openai import OpenAI

from . import curriculum
from .config import settings
from .errors import AppError
from .prompts import day_field_system_prompt, day_system_prompt, week_system_prompt
from .retrieval import RetrievalResult
from .schema import DAY_JSON_SCHEMA, PLAN_JSON_SCHEMA, field_json_schema, loads_lenient
from . import db

log = logging.getLogger("aplang.llm")


@functools.lru_cache(maxsize=1)
def client() -> OpenAI:
    if not settings.has_api_key:
        raise AppError(
            "no_api_key",
            "OPENAI_API_KEY is not set.",
            hint="Add it to the .env file at the project root (see .env.example).",
        )
    return OpenAI(api_key=settings.openai_api_key)


def _response_format(name: str, schema: dict) -> dict:
    return {
        "type": "json_schema",
        "json_schema": {"name": name, "strict": True, "schema": schema},
    }


def _check_refusal(message) -> None:
    refusal = getattr(message, "refusal", None)
    if refusal:
        raise AppError("model_refusal", f"The model declined this request: {refusal}", status=422)


def _record(user_id: str, kind: str, usage) -> None:
    """The other half of entitlement.py's weekly cap — every real model call
    reports what it actually spent here. Never worth failing the call over,
    which is why db.record_usage already swallows its own errors; this just
    skips the call entirely if OpenAI didn't hand back a usage object."""
    if not usage:
        return
    db.record_usage(
        user_id, kind, getattr(usage, "prompt_tokens", 0) or 0, getattr(usage, "completion_tokens", 0) or 0
    )


def map_context_for(user_id: str, subject: str, query: str) -> str:
    """Snippets from the teacher's own active pacing guide, relevant to `query`.

    Public (not `_`-prefixed) because the conversational chat model needs this
    exact same lookup — the brainstorming assistant was answering "I don't
    have access to your settings or any attachments" to a teacher who HAD
    uploaded a pacing guide, because chat_stream never called this at all.
    Only the plan-writing calls below did.
    """
    active = db.get_active_curriculum_map(user_id, subject)
    return curriculum.retrieve_map_context(active["id"], query) if active else ""


def generate_plan(user_id: str, query: str, result: RetrievalResult) -> dict:
    """Non-streaming week generation. Returns parsed (not yet validated) JSON."""
    s = db.get_settings_row(user_id)
    map_context = map_context_for(user_id, s["subject"], query)
    resp = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.2,
        max_tokens=4000,
        response_format=_response_format("weekly_lesson_plan", PLAN_JSON_SCHEMA),
        messages=[
            {
                "role": "system",
                "content": week_system_prompt(
                    result, subject=s["subject"], grade=s["grade"], map_context=map_context
                ),
            },
            {"role": "user", "content": query},
        ],
    )
    msg = resp.choices[0].message
    _check_refusal(msg)
    _record(user_id, "generate_plan", resp.usage)
    return loads_lenient(msg.content or "")


def stream_plan(user_id: str, query: str, result: RetrievalResult) -> Iterator[str]:
    """Yield raw content deltas. The caller accumulates and validates."""
    s = db.get_settings_row(user_id)
    map_context = map_context_for(user_id, s["subject"], query)
    stream = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.2,
        max_tokens=4000,
        response_format=_response_format("weekly_lesson_plan", PLAN_JSON_SCHEMA),
        messages=[
            {
                "role": "system",
                "content": week_system_prompt(
                    result, subject=s["subject"], grade=s["grade"], map_context=map_context
                ),
            },
            {"role": "user", "content": query},
        ],
        stream=True,
        # A streamed response has no single .usage the way a plain
        # completion does — without this the whole most expensive call this
        # app makes (4000 max_tokens, run on every generate) went unmetered.
        # The usage-bearing chunk has choices=[], so it survives the
        # `if not chunk.choices: continue` below only because it's checked
        # first.
        stream_options={"include_usage": True},
    )
    try:
        for chunk in stream:
            if getattr(chunk, "usage", None):
                _record(user_id, "stream_plan", chunk.usage)
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if getattr(delta, "refusal", None):
                raise AppError(
                    "model_refusal", f"The model declined this request: {delta.refusal}", status=422
                )
            if delta.content:
                yield delta.content
    finally:
        # Releases the underlying HTTP connection if the caller stops
        # iterating early (Stop clicked mid-stream) rather than leaving it to
        # the SDK's own GC-triggered cleanup.
        stream.close()


def rewrite_day(user_id: str, day: dict, feedback: str, full_plan_context: str, result: RetrievalResult) -> dict:
    """Revise one day. Emits the SAME schema as generate_plan's days.

    Previously this returned split do_now/during/assessment with
    engagement_strategy as an array while generate emitted a flat `lesson`
    string — so a rewritten day could not be merged back into the week.
    """
    s = db.get_settings_row(user_id)
    resp = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.3,
        max_tokens=1600,
        response_format=_response_format("lesson_plan_day", DAY_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": day_system_prompt(result, full_plan_context, subject=s["subject"], grade=s["grade"])},
            {
                "role": "user",
                "content": (
                    f"The day to revise:\n{json.dumps(day, indent=2)}\n\n"
                    f"Teacher's feedback: {feedback}"
                ),
            },
        ],
    )
    msg = resp.choices[0].message
    _check_refusal(msg)
    _record(user_id, "rewrite_day", resp.usage)
    return loads_lenient(msg.content or "")


def rewrite_day_field(
    user_id: str,
    day: dict,
    feedback: str,
    field: str,
    full_plan_context: str,
    result: RetrievalResult,
):
    """Rewrite ONE field of one day. Returns just that field's value.

    The counterpart to rewrite_day, and the reason in-cell tweaking is safe: the
    model is handed a one-key schema, so it has no way to emit a replacement for
    a sibling field even if the feedback tempts it to. The service merges the
    returned value over a single key and leaves the rest byte-identical.

    `field` MUST already be validated against schema.REVISABLE_FIELDS — it is
    interpolated into the prompt and the response schema as a key name.
    """
    s = db.get_settings_row(user_id)
    resp = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.3,
        # One cell, not seven. The whole-day call needs 1600.
        max_tokens=700,
        response_format=_response_format(f"lesson_plan_day_{field}", field_json_schema(field)),
        messages=[
            {
                "role": "system",
                "content": day_field_system_prompt(
                    result, full_plan_context, field, subject=s["subject"], grade=s["grade"]
                ),
            },
            {
                "role": "user",
                "content": (
                    f"The day as it stands:\n{json.dumps(day, indent=2)}\n\n"
                    f"Rewrite only `{field}`.\n"
                    f"Teacher's feedback: {feedback}"
                ),
            },
        ],
    )
    msg = resp.choices[0].message
    _check_refusal(msg)
    _record(user_id, "rewrite_day_field", resp.usage)
    payload = loads_lenient(msg.content or "")
    if not isinstance(payload, dict) or field not in payload:
        raise AppError(
            "field_rewrite_empty",
            f"The model did not return a new '{field}'.",
            status=502,
            hint="Try rephrasing the tweak, or revise the whole day instead.",
        )
    return payload[field]


_CRITIQUE_PROMPT = """You are a master curriculum coordinator. Your job is to review a drafted lesson plan against the exact academic standards retrieved for it.
1. Are there any activities that do not directly address the standard?
2. Are any cited standard codes hallucinated (not in the provided context)?
3. Is there a logical progression through the week?

Provide a brief, stern critique, then rewrite the ENTIRE week's plan to fix the issues while strictly adhering to the schema.
"""

def critique_and_revise(
    user_id: str, plan: dict, retrieved_context: str, feedback: str | None = None
) -> dict:
    """Rewrites the whole plan — either on the teacher's instruction, or, with no
    instruction, as an autonomous self-critique.

    `feedback` is what makes the chat loop work. Without it this could only ever
    do what it thought best, so a teacher saying "make Thursday a Socratic
    seminar" had nowhere to go but a per-day revise. When feedback is present it
    OUTRANKS the critique prompt: the teacher asking for something is not a
    defect to be corrected, and a self-critique that quietly undoes what they
    just asked for is the most annoying possible behaviour.
    """
    s = db.get_settings_row(user_id)

    if feedback:
        instruction = (
            "Revise the plan to do what the teacher asks. Their instruction is "
            "the requirement — do not overrule it with your own judgement.\n"
            "Change only what the instruction implies; leave every other day and "
            "field exactly as it is. Keep every standard code grounded in the "
            "retrieved context below; do not introduce a code that is not there.\n\n"
            f"Teacher's instruction:\n{feedback}"
        )
    else:
        instruction = _CRITIQUE_PROMPT

    resp = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.3,
        max_tokens=4000,
        response_format=_response_format("weekly_lesson_plan", PLAN_JSON_SCHEMA),
        messages=[
            {
                "role": "system",
                "content": (
                    f"{instruction}\n\n"
                    f"Subject: {s['subject']} (Grade {s['grade']})\n\n"
                    f"Retrieved Standards Context:\n{retrieved_context}"
                )
            },
            {
                "role": "user",
                "content": f"Here is the current plan:\n{json.dumps(plan, indent=2)}"
            },
        ],
    )
    msg = resp.choices[0].message
    _check_refusal(msg)
    _record(user_id, "critique_and_revise", resp.usage)
    return loads_lenient(msg.content or "")


QUERY_EXPANSION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "queries": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3 to 5 short skill-phrased search queries.",
        }
    },
    "required": ["queries"],
}

_EXPANSION_PROMPT = """You turn a teacher's lesson-plan request into search queries for a
database of academic standards.

Standards are written as abstract skill statements — "Explain how word choice,
comparisons, and syntax contribute to a text's tone" — and never mention specific
texts, authors, week numbers, or courses. So a request like "Week 6, voice and
tone with The Cask of Amontillado" retrieves badly: the proper nouns dominate the
embedding and every relevant skill falls out of range.

Rewrite the request as 3 to 5 short queries in that abstract skill register.
Strip week numbers, titles, and author names. Cover the distinct skills the week
would actually teach — reading analysis, writing, language conventions, speaking
and listening — one query each, so different families of standards can match."""


def expand_query(user_id: str, query: str) -> list[str]:
    """Rephrase a teacher's request into standards-register search queries.

    Measured effect: AP skill chunks for "Week 6 voice and tone with The Cask of
    Amontillado" sit at 0.89, beyond the relevance floor, while the same skills
    match "how word choice and syntax convey tone" at 0.41. Without this step the
    generator gets no AP skills for a normal request and fills the gap from
    memory. Uses a cheap model; falls back to the raw query on any failure.
    """
    try:
        resp = client().chat.completions.create(
            model="gpt-4o-mini",
            temperature=0,
            max_tokens=300,
            response_format=_response_format("expanded_queries", QUERY_EXPANSION_SCHEMA),
            messages=[
                {"role": "system", "content": _EXPANSION_PROMPT},
                {"role": "user", "content": query[:2000]},
            ],
        )
        _record(user_id, "expand_query", resp.usage)
        data = json.loads(resp.choices[0].message.content or "{}")
        out = [q.strip() for q in data.get("queries", []) if isinstance(q, str) and q.strip()]
        log.info("expanded query into %d searches", len(out))
        return out[:5]
    except Exception as e:  # noqa: BLE001 — expansion is an optimisation, never a hard failure
        log.warning("query expansion failed, using the raw query: %s", e)
        return []


TITLE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {
            "type": "string",
            "description": "A short, specific chat title, 3-6 words, no quotes or trailing punctuation.",
        }
    },
    "required": ["title"],
}

_TITLE_PROMPT = """Give this teacher's message a short chat title, 3-6 words.

Name the concrete thing they're planning — the unit, text, or skill — not the
fact that they're asking for a lesson plan (every chat here is that). Teachers
often open with the same boilerplate instruction ("interview me to help me
build..."), so look past it for whatever specific is buried in it: a week
number, an anchor text, a skill, a standard. If nothing specific is there,
summarize the actual request in plain words instead. No quotes, no trailing
punctuation."""


def generate_chat_title(user_id: str, message: str) -> str:
    """A short descriptive title for a new chat, replacing a truncated first line.

    Teachers' opening messages are often identical boilerplate ("I want you to
    interview me to help me build...") repeated chat after chat, so slicing the
    first 40 characters produced a sidebar where every row read the same. Falls
    back to that same truncation on any failure — this is cosmetic, never worth
    blocking chat creation over.
    """
    try:
        resp = client().chat.completions.create(
            model="gpt-4o-mini",
            temperature=0.3,
            max_tokens=60,
            response_format=_response_format("chat_title", TITLE_SCHEMA),
            messages=[
                {"role": "system", "content": _TITLE_PROMPT},
                {"role": "user", "content": message[:2000]},
            ],
        )
        _record(user_id, "generate_chat_title", resp.usage)
        title = json.loads(resp.choices[0].message.content or "{}").get("title", "").strip()
        if title:
            return title[:80]
    except Exception as e:  # noqa: BLE001 — a title is cosmetic, never a hard failure
        log.warning("chat title generation failed, falling back to truncation: %s", e)
    first_line = message.split("\n")[0].strip() or "New plan"
    return first_line[:40] + ("…" if len(first_line) > 40 else "")


def transcribe(user_id: str, path: str) -> str:
    with open(path, "rb") as f:
        result = client().audio.transcriptions.create(model="whisper-1", file=f)
    # Whisper and TTS bill per minute / per character, not per token, so
    # there's no real usage.prompt_tokens to read — without SOME charge here
    # they'd be a free channel outside the cap this whole feature exists to
    # enforce. ~1200 is Whisper's per-minute cost ($0.006) converted to
    # gpt-4o-equivalent tokens at that model's own blended rate, assuming a
    # generous one-minute clip — approximate on purpose, not a real invoice.
    db.record_usage(user_id, "transcribe", 1200, 0)
    return result.text


def synthesize_speech(user_id: str, text: str) -> bytes:
    """The other half of transcribe() above — text in, spoken audio out."""
    resp = client().audio.speech.create(
        model=settings.tts_model,
        voice=settings.tts_voice,
        input=text,
        response_format="mp3",
    )
    # Same reasoning as transcribe(): TTS bills per character ($0.015/1K),
    # converted to a gpt-4o-equivalent token count so it draws from the same
    # cap rather than being a free channel.
    db.record_usage(user_id, "synthesize_speech", len(text) * 3, 0)
    return resp.content


def stream_chat(user_id: str, messages: list[dict]) -> Iterator[dict]:
    """Conversational streaming. Yields dicts with 'chunk' or 'tool_call'.

    The first message should be the system prompt.
    """
    tools = [
        {
            "type": "function",
            "function": {
                "name": "generate_lesson_plan",
                "description": "Trigger the generation or revision of the lesson plan artifact based on the conversation.",
            },
        },
        {
            "type": "function",
            "function": {
                "name": "ask_clarifying_questions",
                # Call this INSTEAD of generate_lesson_plan, not before it —
                # the two are alternatives, not a required first step. A
                # request that already names a text/topic and a rough shape
                # ("plan a week on Gatsby ch 3-4, rhetorical analysis") has
                # enough to build from immediately. Not limited to the first
                # message of a request anymore — any turn where the teacher's
                # last message is too vague to act on (a brand-new request, a
                # follow-up brainstorm, or "can you revise this" with no
                # specifics on what to change) is fair game, tapping through
                # options beats typing a paragraph either way.
                "description": (
                    "Call this INSTEAD of generate_lesson_plan when the teacher's most recent message is too "
                    "vague to build or revise a specific week from — whether that's the start of a new "
                    "request, a follow-up in an ongoing brainstorm, or a revision ask with no specifics "
                    "('can you change Thursday?' with no hint of how). Ask 2-4 short, concrete questions, "
                    "each with a few clickable options, so the teacher can tap through rather than type a "
                    "paragraph. Don't ask again about something they already answered or already specified."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "questions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string", "description": "A short, stable slug, e.g. 'text' or 'skill'."},
                                    "text": {"type": "string", "description": "The question itself, one sentence."},
                                    "options": {
                                        "type": "array",
                                        "minItems": 2,
                                        "maxItems": 5,
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": ["id", "text", "options"],
                            },
                        }
                    },
                    "required": ["questions"],
                },
            },
        },
    ]

    stream = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.7,
        max_tokens=4000,
        messages=messages,
        stream=True,
        tools=tools,
        # See stream_plan's identical option — without it this call, which
        # runs on every non-generating chat turn too, went unmetered.
        stream_options={"include_usage": True},
    )
    # generate_lesson_plan carries no arguments worth waiting on — the plan
    # itself comes from a separate call once the client sees that signal, not
    # from parsing this tool's own payload, so it still fires on the first
    # sighting like before. ask_clarifying_questions is the opposite: its
    # arguments ARE the entire payload, streamed as fragments of a JSON
    # string across several chunks, so it has to accumulate until the model
    # actually finishes the call before there's anything valid to parse.
    tool_name = None
    tool_args = ""
    try:
        for chunk in stream:
            if getattr(chunk, "usage", None):
                _record(user_id, "stream_chat", chunk.usage)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta
            if getattr(delta, "refusal", None):
                raise AppError(
                    "model_refusal", f"The model declined this request: {delta.refusal}", status=422
                )

            if getattr(delta, "tool_calls", None):
                call = delta.tool_calls[0]
                fn = getattr(call, "function", None)
                if fn and getattr(fn, "name", None):
                    tool_name = fn.name
                if fn and getattr(fn, "arguments", None):
                    tool_args += fn.arguments
                if tool_name == "generate_lesson_plan":
                    yield {"tool_call": "generate_lesson_plan"}
                    break
                continue

            if choice.finish_reason == "tool_calls" and tool_name == "ask_clarifying_questions":
                try:
                    questions = json.loads(tool_args).get("questions") or []
                except ValueError:
                    questions = []
                if questions:
                    yield {"tool_call": "ask_clarifying_questions", "questions": questions}
                break

            if delta.content:
                yield {"chunk": delta.content}
    finally:
        stream.close()

