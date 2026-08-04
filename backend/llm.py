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

from .config import settings
from .errors import AppError
from .prompts import day_system_prompt, week_system_prompt
from .retrieval import RetrievalResult
from .schema import DAY_JSON_SCHEMA, PLAN_JSON_SCHEMA, loads_lenient

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


def generate_plan(query: str, result: RetrievalResult) -> dict:
    """Non-streaming week generation. Returns parsed (not yet validated) JSON."""
    resp = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.2,
        max_tokens=4000,
        response_format=_response_format("weekly_lesson_plan", PLAN_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": week_system_prompt(result)},
            {"role": "user", "content": query},
        ],
    )
    msg = resp.choices[0].message
    _check_refusal(msg)
    log.info(
        "generate_plan tokens_in=%s tokens_out=%s",
        resp.usage.prompt_tokens if resp.usage else "?",
        resp.usage.completion_tokens if resp.usage else "?",
    )
    return loads_lenient(msg.content or "")


def stream_plan(query: str, result: RetrievalResult) -> Iterator[str]:
    """Yield raw content deltas. The caller accumulates and validates."""
    stream = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.2,
        max_tokens=4000,
        response_format=_response_format("weekly_lesson_plan", PLAN_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": week_system_prompt(result)},
            {"role": "user", "content": query},
        ],
        stream=True,
    )
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if getattr(delta, "refusal", None):
            raise AppError(
                "model_refusal", f"The model declined this request: {delta.refusal}", status=422
            )
        if delta.content:
            yield delta.content


def rewrite_day(day: dict, feedback: str, full_plan_context: str, result: RetrievalResult) -> dict:
    """Revise one day. Emits the SAME schema as generate_plan's days.

    Previously this returned split do_now/during/assessment with
    engagement_strategy as an array while generate emitted a flat `lesson`
    string — so a rewritten day could not be merged back into the week.
    """
    resp = client().chat.completions.create(
        model=settings.openai_model,
        temperature=0.3,
        max_tokens=1600,
        response_format=_response_format("lesson_plan_day", DAY_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": day_system_prompt(result, full_plan_context)},
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


def expand_query(query: str) -> list[str]:
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
        data = json.loads(resp.choices[0].message.content or "{}")
        out = [q.strip() for q in data.get("queries", []) if isinstance(q, str) and q.strip()]
        log.info("expanded query into %d searches", len(out))
        return out[:5]
    except Exception as e:  # noqa: BLE001 — expansion is an optimisation, never a hard failure
        log.warning("query expansion failed, using the raw query: %s", e)
        return []


def transcribe(path: str) -> str:
    with open(path, "rb") as f:
        result = client().audio.transcriptions.create(model="whisper-1", file=f)
    return result.text
