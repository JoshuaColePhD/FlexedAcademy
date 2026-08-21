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
import hashlib
import json
import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, wait

from openai import OpenAI

from . import curriculum
from .config import settings
from .errors import AppError
from .embeddings import embed_query
from .prompts import day_field_system_prompt, day_system_prompt, week_system_prompt
from .retrieval import RetrievalResult
from .schema import (
    CALENDAR_JSON_SCHEMA,
    DAY_JSON_SCHEMA,
    PLAN_JSON_SCHEMA,
    QUIZ_JSON_SCHEMA,
    TEMPLATE_ANALYSIS_JSON_SCHEMA,
    TEMPLATE_VERIFICATION_JSON_SCHEMA,
    field_json_schema,
    loads_lenient,
)
from . import db

log = logging.getLogger("aplang.llm")

# A hung call sitting open indefinitely (rather than erroring) is what turns a
# transient upstream blip into "the chat is stuck" for the teacher watching it.
# 30s comfortably covers a slow first token on a 4000-max-tokens completion;
# max_retries=2 (the SDK default) still applies underneath this, for the
# connection-level errors it retries before it ever reaches our code.
_REQUEST_TIMEOUT_S = 30.0

# retrieve_map_context is a nice-to-have supplement, not something the teacher
# is aware is even running — it must never be the reason a chat reply is slow
# to start. Bounded in its own thread so a slow embeddings call or DB query
# degrades to "no map context" instead of stalling the first token.
_MAP_CONTEXT_TIMEOUT_S = 4.0
_context_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="map-context")


@functools.lru_cache(maxsize=1)
def client() -> OpenAI:
    if not settings.has_api_key:
        raise AppError(
            "no_api_key",
            "OPENAI_API_KEY is not set.",
            hint="Add it to the .env file at the project root (see .env.example).",
        )
    return OpenAI(api_key=settings.openai_api_key, timeout=_REQUEST_TIMEOUT_S)


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


def map_context_for(user_id: str, subject: str, query: str, class_id: str | None = None) -> str:
    """Snippets from the teacher's own active pacing guides and global documents, relevant to `query`.

    Public (not `_`-prefixed) because the conversational chat model needs this
    exact same lookup.
    """
    docs = []
    if class_id:
        docs.extend(db.list_class_documents(user_id, class_id))
    else:
        active = db.get_active_curriculum_map(user_id, subject)
        if active:
            docs.append(active)
            
    docs.extend(db.list_global_documents(user_id))
    
    if not docs:
        return ""

    try:
        query_vector = embed_query(query)
    except Exception as e:  # noqa: BLE001
        log.warning("curriculum map query embedding failed: %s", e)
        return ""

    futures = [
        _context_pool.submit(curriculum.retrieve_map_context, doc["id"], query, 4, query_vector)
        for doc in docs
    ]
    
    results = []
    done, pending = wait(futures, timeout=_MAP_CONTEXT_TIMEOUT_S)
    if pending:
        log.warning("%d map context lookups exceeded %.1fs", len(pending), _MAP_CONTEXT_TIMEOUT_S)
    for future in futures:
        if future not in done:
            continue
        try:
            res = future.result()
            if res:
                results.append(res)
        except Exception as e:  # noqa: BLE001
            log.warning("map context lookup failed: %s", e)

    for future in pending:
        future.cancel()
            
    return "\n\n".join(results)


def custom_instructions_for(user_id: str) -> str | None:
    """A teacher's global custom instructions (settings page) — one column
    on `users`, read alongside settings by every prompt-building call below.
    Public for the same reason map_context_for is: chat_stream (generate.py)
    needs this exact same lookup too."""
    user = db.get_user_by_id(user_id)
    return user.get("custom_instructions") if user else None


def _cached_completion(user_id: str, kind: str, **kwargs):
    """Checks the database cache before calling OpenAI."""
    # We only cache if we have a stable way to hash the request
    messages = kwargs.get("messages", [])
    model = kwargs.get("model", "")
    temperature = kwargs.get("temperature", 0)
    response_format = kwargs.get("response_format", None)
    
    data = {
        "model": model,
        "temperature": temperature,
        "messages": messages,
        "response_format": response_format,
    }
    hash_key = hashlib.sha256(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()
    
    cached = db.get_llm_cache(hash_key)
    if cached is not None:
        log.info("LLM cache hit for %s", kind)
        return cached

    resp = client().chat.completions.create(**kwargs)
    msg = resp.choices[0].message
    _check_refusal(msg)
    _record(user_id, kind, resp.usage)
    
    if msg.content:
        db.set_llm_cache(hash_key, msg.content)
    return msg.content


def generate_plan(user_id: str, query: str, result: RetrievalResult, *, school_id: str, class_id: str | None = None) -> dict:
    """Non-streaming week generation. Returns parsed (not yet validated) JSON.

    `school_id` is taken as a parameter rather than resolved here (it used to
    be db.get_user_school(user_id)) so the caller can hand over the CHAT's
    own class's school (db.class_school, migration 25) instead of always the
    account default — a class at a different school than the account default
    would otherwise get the wrong one named in its own prompt."""
    s = db.get_settings_row(user_id)
    map_context = map_context_for(user_id, s["subject"], query, class_id=class_id)
    content = _cached_completion(
        user_id,
        "generate_plan",
        model=settings.openai_model,
        max_completion_tokens=4000,
        response_format=_response_format("weekly_lesson_plan", PLAN_JSON_SCHEMA),
        messages=[
            {
                "role": "system",
                "content": week_system_prompt(
                    result,
                    subject=s["subject"],
                    grade=s["grade"],
                    map_context=map_context,
                    custom_instructions=custom_instructions_for(user_id),
                    school_id=school_id,
                ),
            },
            {"role": "user", "content": query},
        ],
    )
    return loads_lenient(content or "")


def stream_plan(user_id: str, query: str, result: RetrievalResult, *, school_id: str, class_id: str | None = None) -> Iterator[str]:
    """Yield raw content deltas. The caller accumulates and validates.

    See generate_plan's own docstring for why `school_id` is a parameter
    rather than resolved internally."""
    s = db.get_settings_row(user_id)
    map_context = map_context_for(user_id, s["subject"], query, class_id=class_id)
    stream = client().chat.completions.create(
        model=settings.openai_model,
        max_completion_tokens=4000,
        response_format=_response_format("weekly_lesson_plan", PLAN_JSON_SCHEMA),
        messages=[
            {
                "role": "system",
                "content": week_system_prompt(
                    result,
                    subject=s["subject"],
                    grade=s["grade"],
                    map_context=map_context,
                    custom_instructions=custom_instructions_for(user_id),
                    school_id=school_id,
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


# Canvas-facing names, not our internal ones — question_types arrives from
# the generate_quiz TOOL CALL (routes/generate.py), whose own description is
# what the model reads to decide what a teacher meant by "multiple choice"
# or "matching quiz", so the wording there and here has to agree.
_QUESTION_TYPE_PROMPT_NAMES = {
    "multiple_choice": "multiple choice",
    "true_false": "true/false",
    "short_answer": "short answer",
    "matching": "matching",
}


def generate_quiz(user_id: str, plan: dict, question_types: list[str], num_questions: int) -> dict:
    """A short quiz over an ALREADY-BUILT plan — no retrieval call of its
    own. The plan's own plan_json is the ONLY source material handed to the
    model, and the prompt forbids citing a standard that isn't already in
    it: the quiz can only test what that week's grounding audit already
    verified, never a code retrieval never actually surfaced for THIS
    generation. Returns parsed (not yet validated — see schema.validate_quiz)
    JSON matching QUIZ_JSON_SCHEMA.
    """
    types_wanted = ", ".join(_QUESTION_TYPE_PROMPT_NAMES.get(t, t) for t in question_types) or "multiple choice"
    system_prompt = (
        "You are writing a short quiz for a lesson plan a teacher already built. "
        "Write ONLY using the content, standards, and vocabulary already present in the plan below — "
        "never invent a standard code, term, or fact that isn't already in it. If a question doesn't "
        "test one specific standard, leave standard_code as an empty string rather than guessing one.\n\n"
        f"Write approximately {num_questions} questions, using ONLY these question type(s): {types_wanted}. "
        "Spread the questions across the days rather than clustering them on one. "
        "Each question must be self-contained — a student answering it should not need to see the plan itself.\n\n"
        "THE WEEK'S PLAN (your only source material):\n\n" + json.dumps(plan, indent=2)
    )
    custom_instructions = custom_instructions_for(user_id)
    if custom_instructions:
        system_prompt += (
            "\n\nTEACHER'S GLOBAL CUSTOM INSTRUCTIONS — style/format preferences only, "
            "never license to add content outside the plan above:\n\n" + custom_instructions
        )
    content = _cached_completion(
        user_id,
        "generate_quiz",
        model=settings.openai_model,
        max_completion_tokens=3000,
        response_format=_response_format("weekly_quiz", QUIZ_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "Write the quiz now."},
        ],
    )
    return loads_lenient(content or "")


def revise_quiz(user_id: str, plan: dict, existing_quiz: dict, feedback: str) -> dict:
    """Revise a quiz that's already been built, on the teacher's own
    follow-up ("make it harder", "add two more questions") — the same
    critique-and-revise shape critique_and_revise uses for a whole plan
    (routes/plans.py's revise_whole_plan): the model sees what it already
    wrote and what to change, not a blank page it has to reconstruct from
    scratch and risk drifting from what the teacher actually asked to keep.

    Exists because iterating on a quiz used to always call generate_quiz
    again, which only ever inserts a new row (routes/plans.py's create_quiz)
    — every "make it harder" produced a whole separate quiz sitting next to
    the one just built, instead of changing it. Still grounded ONLY in the
    plan's own content, same reasoning and same guard as generate_quiz.
    """
    system_prompt = (
        "You are revising a quiz you already wrote for a lesson plan a teacher built. "
        "Write ONLY using the content, standards, and vocabulary already present in the plan below — "
        "never invent a standard code, term, or fact that isn't already in it. Keep the same question "
        "types and roughly the same number of questions as the quiz below unless the teacher's feedback "
        "says otherwise.\n\n"
        "THE WEEK'S PLAN (your only source material):\n\n" + json.dumps(plan, indent=2)
        + "\n\nTHE QUIZ YOU ALREADY WROTE:\n\n" + json.dumps(existing_quiz, indent=2)
    )
    custom_instructions = custom_instructions_for(user_id)
    if custom_instructions:
        system_prompt += (
            "\n\nTEACHER'S GLOBAL CUSTOM INSTRUCTIONS — style/format preferences only, "
            "never license to add content outside the plan above:\n\n" + custom_instructions
        )
    content = _cached_completion(
        user_id,
        "revise_quiz",
        model=settings.openai_model,
        max_completion_tokens=3000,
        response_format=_response_format("weekly_quiz", QUIZ_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Revise the quiz above. Teacher's feedback: {feedback}"},
        ],
    )
    return loads_lenient(content or "")


def rewrite_day(user_id: str, day: dict, feedback: str, full_plan_context: str, result: RetrievalResult) -> dict:
    """Revise one day. Emits the SAME schema as generate_plan's days.

    Previously this returned split do_now/during/assessment with
    engagement_strategy as an array while generate emitted a flat `lesson`
    string — so a rewritten day could not be merged back into the week.
    """
    s = db.get_settings_row(user_id)
    content = _cached_completion(
        user_id,
        "rewrite_day",
        model=settings.openai_model,
        max_completion_tokens=1600,
        response_format=_response_format("lesson_plan_day", DAY_JSON_SCHEMA),
        messages=[
            {
                "role": "system",
                "content": day_system_prompt(
                    result,
                    full_plan_context,
                    subject=s["subject"],
                    grade=s["grade"],
                    custom_instructions=custom_instructions_for(user_id),
                ),
            },
            {
                "role": "user",
                "content": (
                    f"The day to revise:\n{json.dumps(day, indent=2)}\n\n"
                    f"Teacher's feedback: {feedback}"
                ),
            },
        ],
    )
    return loads_lenient(content or "")


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
    content = _cached_completion(
        user_id,
        "rewrite_day_field",
        model=settings.openai_model,
        max_completion_tokens=700,
        response_format=_response_format(f"lesson_plan_day_{field}", field_json_schema(field)),
        messages=[
            {
                "role": "system",
                "content": day_field_system_prompt(
                    result,
                    full_plan_context,
                    field,
                    subject=s["subject"],
                    grade=s["grade"],
                    custom_instructions=custom_instructions_for(user_id),
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
    payload = loads_lenient(content or "")
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

    content = _cached_completion(
        user_id,
        "critique_and_revise",
        model=settings.openai_model,
        max_completion_tokens=4000,
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
    return loads_lenient(content or "")


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
        content = _cached_completion(
            user_id,
            "expand_query",
            model="gpt-5.6-luna",
            max_completion_tokens=300,
            response_format=_response_format("expanded_queries", QUERY_EXPANSION_SCHEMA),
            messages=[
                {"role": "system", "content": _EXPANSION_PROMPT},
                {"role": "user", "content": query[:2000]},
            ],
        )
        data = json.loads(content or "{}")
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
        content = _cached_completion(
            user_id,
            "generate_chat_title",
            model="gpt-5.6-luna",
            max_completion_tokens=60,
            response_format=_response_format("chat_title", TITLE_SCHEMA),
            messages=[
                {"role": "system", "content": _TITLE_PROMPT},
                {"role": "user", "content": message[:2000]},
            ],
        )
        title = json.loads(content or "{}").get("title", "").strip()
        if title:
            return title[:80]
    except Exception as e:  # noqa: BLE001 — a title is cosmetic, never a hard failure
        log.warning("chat title generation failed, falling back to truncation: %s", e)
    first_line = message.split("\n")[0].strip() or "New plan"
    return first_line[:40] + ("…" if len(first_line) > 40 else "")


_CALENDAR_PARSE_PROMPT = """You are reading the text of a school district's published academic calendar.
Turn it into a numbered list of teaching weeks, in order, starting at week 1.

For each week give:
- week: sequential integer starting at 1 (do not skip numbers for a break week — a break is a week with no_school=true, not a gap in numbering).
- start / end: the ISO date (YYYY-MM-DD) the week's school days begin and end. Infer the year from the calendar's own title or date range if the table itself omits it. Leave both null ONLY if this particular week's dates genuinely cannot be determined from the text — never guess or invent a date.
- notes: a short label if the week is a holiday, break, or has a testing/early-release day — otherwise ''.
- no_school: true only if the ENTIRE week has no school.
- closures: true if any single day in the week is closed, even if the rest of the week is normal.

Stop once the school year in the source text ends. Do not invent weeks beyond what the calendar states."""


def parse_calendar_weeks(user_id: str, text: str) -> list[dict]:
    """One structured-output call turning extracted calendar text into the
    exact week-dict shape schoolcal.py's hand-curated parser produces.
    Raises AppError/SchemaError upward on a bad response — the caller
    (calendar_intake.py) is what runs the sanity checks on the result."""
    content = _cached_completion(
        user_id,
        "parse_calendar_weeks",
        model=settings.openai_model,
        max_completion_tokens=4000,
        response_format=_response_format("school_calendar", CALENDAR_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": _CALENDAR_PARSE_PROMPT},
            {"role": "user", "content": text[:20000]},
        ],
    )
    parsed = loads_lenient(content or "")
    return parsed.get("weeks") or []


_TEMPLATE_ANALYSIS_PROMPT = """You are reading a deterministic structural extraction of a school's blank \
lesson-plan template — its headings, table layouts, and font/style usage — never the original file. Your job \
is to map that structure onto the sections a lesson-plan generator would need to fill in.

For each distinct section or field you can identify:
- name: a short label for it.
- description: what content belongs there, in plain language.
- source_evidence: the EXACT heading text, table header, or label from the extraction below that grounds this \
section. Copy it verbatim, character for character. Never paraphrase, summarize, or invent one — if you cannot \
point to real text in the extraction, do not report the section at all.
- repeats_per_entry: true if this appears once per day/lesson/week (e.g. a table row repeated per day) rather \
than once for the whole document.

List anything whose purpose or expected format you are not confident about in unclear_or_ambiguous instead of \
guessing. Set overall_confidence honestly — a template with sparse or ambiguous structure should score low, \
not be forced into an optimistic-sounding number. Set recommended_for_auto_use to true only if a builder script \
could be written from your `sections` alone, with no human needing to re-open the original file."""


def analyze_template_structure(user_id: str, structure_summary: str) -> dict:
    """One structured-output call turning template_intake.py's deterministic
    extraction (never the raw file) into a proposed section/field mapping.

    Raises AppError/SchemaError upward on a bad response — template_intake.py
    is what cross-checks source_evidence against the extraction and decides
    whether the result is trustworthy enough to show an admin as-is."""
    content = _cached_completion(
        user_id,
        "analyze_template_structure",
        model=settings.openai_model,
        max_completion_tokens=4000,
        temperature=0,
        response_format=_response_format("template_structure", TEMPLATE_ANALYSIS_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": _TEMPLATE_ANALYSIS_PROMPT},
            {"role": "user", "content": structure_summary[:20000]},
        ],
    )
    return loads_lenient(content or "")


_TEMPLATE_VERIFY_PROMPT = """You are auditing another model's proposed section mapping for a lesson-plan \
template, checking it against the same structural extraction it was given. Be skeptical: your job is to catch \
mistakes, not rubber-stamp the proposal — assume the other model may have misread something.

For EACH proposed section, decide whether its description genuinely matches what its cited evidence shows — \
not just whether the evidence text exists (that was already checked separately), but whether the description \
is an accurate read of it. Mark accurate=false for anything that misreads, overstates, or invents meaning \
beyond what the evidence actually supports. When you are unsure, default to accurate=false rather than true — \
a missed valid section costs a human reviewer a few seconds re-adding it; a wrongly-approved one costs them \
trust in every other section you approved."""


def verify_template_sections(user_id: str, structure_summary: str, sections: list[dict]) -> dict:
    """A second, independently-framed pass auditing analyze_template_structure's
    own output against the same extraction it was given — not a re-run of the
    same prompt (which would likely just repeat the same mistake), but a
    skeptical review of specific claims already made. template_intake.py
    drops any section this call marks inaccurate."""
    sections_text = "\n".join(
        f"- name: {s['name']!r}\n  description: {s['description']!r}\n  evidence: {s['source_evidence']!r}"
        for s in sections
    )
    content = _cached_completion(
        user_id,
        "verify_template_sections",
        model=settings.openai_model,
        max_completion_tokens=2000,
        temperature=0,
        response_format=_response_format("template_verification", TEMPLATE_VERIFICATION_JSON_SCHEMA),
        messages=[
            {"role": "system", "content": _TEMPLATE_VERIFY_PROMPT},
            {
                "role": "user",
                "content": f"Structural extraction:\n{structure_summary[:20000]}\n\nProposed sections:\n{sections_text[:8000]}",
            },
        ],
    )
    return loads_lenient(content or "")


DECISIONS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "decisions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "label": {
                        "type": "string",
                        "description": "1-3 words naming WHAT was decided, e.g. 'Week', 'Anchor text', 'Assessment'.",
                    },
                    "value": {
                        "type": "string",
                        "description": "The actual decision, under about 8 words.",
                    },
                },
                "required": ["label", "value"],
            },
        }
    },
    "required": ["decisions"],
}

_DECISIONS_PROMPT = """Read this planning conversation between a teacher and an \
assistant building a week of lessons. List only the concrete decisions actually \
SETTLED so far — a week chosen, a text or anchor named, a unit or skill focus, an \
assessment type, a specific constraint given. Do not include anything still open, \
being asked about, or only suggested and not yet confirmed. One row per decision, \
in the order they were made. A short label (1-3 words) and a short value (under 8 \
words). If nothing has been settled yet, return an empty list."""


def extract_decisions(user_id: str, messages: list[dict]) -> list[dict]:
    """Voice mode's card stack — a running, best-effort read of what's actually
    been settled in the conversation so far.

    Not a fixed checklist: there's no set list of "the questions" a plan
    always answers (schema.py's DAY_JSON_SCHEMA varies with what the teacher
    actually asks for), so this re-reads the whole transcript each call and
    reports back whatever it can find. Cheap model, swallows failures — this
    is a visual aid for a live conversation, never worth blocking or erroring
    it over.
    """
    if not messages:
        return []
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in messages[-16:])
    try:
        content = _cached_completion(
            user_id,
            "extract_decisions",
            model="gpt-5.6-luna",
            max_completion_tokens=400,
            response_format=_response_format("decisions", DECISIONS_SCHEMA),
            messages=[
                {"role": "system", "content": _DECISIONS_PROMPT},
                {"role": "user", "content": convo[:6000]},
            ],
        )
        data = json.loads(content or "{}")
        out = []
        for d in data.get("decisions", []):
            label = str(d.get("label", "")).strip()
            value = str(d.get("value", "")).strip()
            if label and value:
                out.append({"label": label[:40], "value": value[:80]})
        return out[:8]
    except Exception as e:  # noqa: BLE001 — a visual aid, never a hard failure
        log.warning("decision extraction failed: %s", e)
        return []


def _no_speech_prob(segment) -> float:
    if isinstance(segment, dict):
        return segment.get("no_speech_prob", 0.0)
    return getattr(segment, "no_speech_prob", 0.0)


def transcribe(user_id: str, path: str) -> str:
    with open(path, "rb") as f:
        result = client().audio.transcriptions.create(
            model="whisper-1",
            file=f,
            # This app is English lesson planning; there is no legitimate
            # reason a clip should ever be anything else. Without this,
            # ambiguous audio (background noise, a cough, silence) lets
            # Whisper's language auto-detect pick something else — confirmed
            # live: a VAD false-positive produced a fluent Korean question
            # about translating a sentence, which the chat model then
            # answered in kind, derailing the whole conversation.
            language="en",
            # Needed for the no_speech_prob check below — plain "text" format
            # gives back nothing to tell a real utterance apart from
            # hallucinated text.
            response_format="verbose_json",
        )
    # Whisper and TTS bill per minute / per character, not per token, so
    # there's no real usage.prompt_tokens to read — without SOME charge here
    # they'd be a free channel outside the cap this whole feature exists to
    # enforce. ~1200 is Whisper's per-minute cost ($0.006) converted to
    # gpt-4o-equivalent tokens at that model's own blended rate, assuming a
    # generous one-minute clip — approximate on purpose, not a real invoice.
    db.record_usage(user_id, "transcribe", 1200, 0)
    # Pinning the language stops Whisper from hallucinating in a RANDOM one,
    # but it can still confidently invent a fluent English sentence from
    # background noise or near-silence — a VAD false positive (the mic
    # picked up SOMETHING, just not speech) with nothing to transcribe.
    # no_speech_prob is Whisper's own per-segment confidence that a stretch
    # of audio wasn't speech at all; if every segment reads that way, the
    # clip is noise, not an utterance, no matter how plausible the invented
    # text sounds. VoiceModePanel's caller already treats an empty string as
    # "nothing said, mic stays live" — the same as a too-short clip.
    segments = getattr(result, "segments", None) or []
    if segments and all(_no_speech_prob(s) > 0.6 for s in segments):
        return ""
    return result.text


def stream_speech(user_id: str, text: str) -> Iterator[bytes]:
    """The other half of transcribe() above — text in, spoken audio out, as a
    stream of chunks rather than one finished clip.

    Was synthesize_speech(), which returned `resp.content`: the complete audio
    file, meaning the caller couldn't send a byte until OpenAI had synthesized
    the last syllable. For a per-sentence pipeline that wait sat in the critical
    path of every sentence. with_streaming_response hands back the body as it
    arrives instead, so /tts can forward it and the browser can start decoding
    the front of the clip while the back is still being made.

    Raw PCM, not MP3 and not WAV — measured against this exact text and voice,
    with a warm connection, first-byte latency was:

        gpt-4o-mini-tts  pcm    351 ms   (886 ms to the last byte)
        gpt-4o-mini-tts  wav    558 ms   (1365 ms)
        gpt-4o-mini-tts  mp3   1723 ms   (2254 ms)
        tts-1            mp3    911 ms   (1116 ms)   <- what this used to be

    The reason is structural rather than incidental: the first bytes of a
    container are header, not audio, and a compressed container can't emit
    anything until the encoder has enough samples to fill a frame. PCM starts
    the moment the model has produced a sample. MP3 also carries LAME's 576
    samples of padding at each end of every clip, which for a reply spoken as
    five sentence-clips is four audible gaps that no amount of scheduling can
    remove.

    The cost is bytes — PCM is ~3x an MP3 of the same speech — and it is worth
    it at these sizes. The client doesn't decode this at all: it builds an
    AudioBuffer from the samples directly (see VoiceProvider), which removes the
    decode step from the critical path too.

    CONTRACT, since headerless bytes carry none of this themselves: signed
    16-bit little-endian PCM, 24kHz, mono. That's what OpenAI's `pcm` format is
    documented to be, and VoiceProvider hardcodes the same three facts.

    Usage is charged UP FRONT, before the first chunk, deliberately: metering
    after the loop would skip the charge entirely for a client that disconnects
    mid-stream (a barge-in, which is a completely ordinary event here), and the
    tokens have been spent by then regardless.
    """
    # Same reasoning as transcribe(): TTS bills per character, converted to a
    # gpt-4o-equivalent token count so it draws from the same cap rather than
    # being a free channel.
    db.record_usage(user_id, "synthesize_speech", len(text) * 3, 0)
    with client().audio.speech.with_streaming_response.create(
        model=settings.tts_model,
        voice=settings.tts_voice,
        input=text,
        response_format="pcm",
    ) as resp:
        # 4KB is ~85ms of 24kHz 16-bit mono — small enough that the first chunk
        # reaches the browser almost immediately, large enough not to spend the
        # trip in per-chunk overhead.
        yield from resp.iter_bytes(4096)


def stream_chat(user_id: str, messages: list[dict], *, voice: bool = False) -> Iterator[dict]:
    """Conversational streaming. Yields dicts with 'chunk' or 'tool_call'.

    The first message should be the system prompt.

    `voice` only tightens the token ceiling — the actual "talk like a person,
    one question at a time" instruction is in the system prompt the route
    builds. This is the backstop for when the model drifts back toward
    written-chat length anyway, which a prompt alone does not reliably
    prevent over a long conversation.
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
                "name": "generate_quiz",
                # ONLY on explicit request, never volunteered — the teacher
                # asked for exactly this (a lesson plan, not a lesson plan
                # PLUS a quiz they didn't ask for), and this tool only makes
                # sense once a plan actually exists for it to test.
                "description": (
                    "Call this ONLY when the teacher explicitly asks for a quiz, test, or assessment as a "
                    "downloadable file, AND their request already says which question type(s) they want and "
                    "roughly how many — never volunteer it alongside a lesson plan, and never guess type or "
                    "count silently: call ask_clarifying_questions instead when either is missing. Requires a "
                    "plan to already exist for this conversation; if none does yet, tell the teacher to build "
                    "the week first instead of calling this. The quiz is built over that plan's own content "
                    "and standards, not anything new."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question_types": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 4,
                            "items": {
                                "type": "string",
                                "enum": ["multiple_choice", "true_false", "short_answer", "matching"],
                            },
                            "description": (
                                "Which type(s) the teacher asked for. Default to ['multiple_choice'] if "
                                "they said 'quiz' or 'test' with no type named."
                            ),
                        },
                        "num_questions": {
                            "type": "integer",
                            "description": "How many questions, if the teacher named a number. Default 10.",
                        },
                        "revises_current": {
                            "type": "boolean",
                            "description": (
                                "True if the teacher is asking to change, fix, or improve the quiz you "
                                "most recently built in this conversation ('make it harder', 'add two "
                                "more questions', 'fix question 3') — the existing quiz gets updated in "
                                "place. False (the default) if they're asking for an ADDITIONAL, distinct "
                                "quiz — a different question type, or a second quiz alongside the first. "
                                "Omit or set false if no quiz has been built yet in this conversation."
                            ),
                        },
                    },
                    "required": ["question_types"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "ask_clarifying_questions",
                # Call this INSTEAD of generate_lesson_plan OR generate_quiz,
                # not before either — these are alternatives, not a required
                # first step. A request that already names a text/topic and a
                # rough shape ("plan a week on Gatsby ch 3-4, rhetorical
                # analysis"), or a quiz request that already names its
                # type(s) and count ("10 multiple choice questions"), has
                # enough to build from immediately. Not limited to the first
                # message of a request — any turn where the teacher's last
                # message is too vague to act on is fair game, tapping
                # through options beats typing a paragraph either way.
                "description": (
                    "Call this INSTEAD of generate_lesson_plan or generate_quiz when the teacher's most recent "
                    "message is too vague to act on directly — a plan request with no text/topic named, a "
                    "revision ask with no specifics ('can you change Thursday?' with no hint of how), or a "
                    "quiz request that doesn't already say which question type(s) and roughly how many. Ask "
                    "2-4 short, concrete questions, each with a few clickable options, so the teacher can tap "
                    "through rather than type a paragraph. Don't ask again about something they already "
                    "answered or already specified."
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
        model=settings.voice_chat_model if voice else settings.openai_model,
        # Required, not tuning: the configured model rejects function tools
        # outright in /v1/chat/completions unless reasoning is off —
        # "Function tools with reasoning_effort are not supported ... set
        # reasoning_effort to 'none'". Both tools below are the entire
        # mechanism of this conversation (build the plan / ask instead), so
        # without this every chat turn, typed or spoken, 400s.
        reasoning_effort="none",
        # Voice replies are deliberately short; the lower ceiling keeps a
        # routing turn from spending time generating an essay before its first
        # sentence can reach the browser.
        max_completion_tokens=700 if voice else 4000,
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
    # Whether anything has actually been handed to the caller yet. Every one
    # of the three things this loop can yield — a text chunk, the
    # generate_lesson_plan signal, a finished ask_clarifying_questions call —
    # sets this. If the stream ends without ever setting it (the model
    # finishes with empty content and no tool call, or tool_calls fires but
    # never reaches a finish_reason this loop recognizes), the caller used to
    # get back nothing at all: no chunk, no tool_call, no error — the route
    # still sends its own {"done": true} regardless, so the frontend saw a
    # "successful" turn with an empty reply and rendered literally nothing.
    # That silent dead air is what made the chat read as broken "a lot of the
    # time" with no error to explain it.
    yielded_anything = False
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
                    yielded_anything = True
                    yield {"tool_call": "generate_lesson_plan"}
                    break
                continue

            if choice.finish_reason == "tool_calls" and tool_name == "ask_clarifying_questions":
                try:
                    questions = json.loads(tool_args).get("questions") or []
                except ValueError:
                    questions = []
                if not questions:
                    # The model committed to asking a question and then sent
                    # back either unparseable JSON or an empty list — there is
                    # no reasonable fallback text to show instead, so this has
                    # to surface as a real error rather than the turn just
                    # evaporating. Retrying is a real fix here, unlike most
                    # errors: this is a formatting slip in one sample, not a
                    # structural failure, so a second attempt often succeeds.
                    raise AppError(
                        "malformed_tool_call",
                        "The model tried to ask a clarifying question but didn't send it back correctly.",
                        status=502,
                        hint="Try sending that again.",
                    )
                yielded_anything = True
                yield {"tool_call": "ask_clarifying_questions", "questions": questions}
                break

            # generate_quiz needs its own arguments before there is anything
            # buildable — same reason ask_clarifying_questions above waits
            # for finish_reason rather than firing on first sighting like
            # generate_lesson_plan does.
            if choice.finish_reason == "tool_calls" and tool_name == "generate_quiz":
                try:
                    args = json.loads(tool_args)
                except ValueError:
                    args = {}
                question_types = args.get("question_types") or []
                if not question_types:
                    raise AppError(
                        "malformed_tool_call",
                        "The model tried to build a quiz but didn't send back which question types.",
                        status=502,
                        hint="Try asking for the quiz again.",
                    )
                yielded_anything = True
                yield {
                    "tool_call": "generate_quiz",
                    "question_types": question_types,
                    "num_questions": args.get("num_questions") or 10,
                    "revises_current": bool(args.get("revises_current")),
                }
                break

            if delta.content:
                yielded_anything = True
                yield {"chunk": delta.content}
    finally:
        stream.close()

    if not yielded_anything:
        raise AppError(
            "empty_reply",
            "The model finished without saying anything.",
            status=502,
            hint="Try sending that again.",
        )


STANDARDS_EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "standards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "code": {"type": "string"},
                    "description": {"type": "string"}
                },
                "required": ["code", "description"],
                "additionalProperties": False
            }
        }
    },
    "required": ["standards"],
    "additionalProperties": False
}

def extract_standards_from_text(text: str) -> list[dict]:
    """Parse raw PDF text of state standards into a clean JSON array."""
    try:
        response = client().chat.completions.create(
            model=settings.openai_model,
            messages=[
                {
                    "role": "system",
                    "content": "You are a specialized parser. Extract every educational standard from the provided document text. "
                               "Return a strictly formatted JSON array containing the standard 'code' (e.g. OH.BIO.1) and "
                               "the 'description'. Do not omit any standards, and do not include extra commentary."
                },
                {"role": "user", "content": text}
            ],
            response_format=_response_format("standards_extraction", STANDARDS_EXTRACTION_SCHEMA),
            temperature=0,
        )
        _check_refusal(response.choices[0].message)
        _record("system", "extract_standards", response.usage)
        
        parsed = json.loads(response.choices[0].message.content)
        return parsed.get("standards", [])
    except Exception as e:
        log.error(f"Failed to extract standards: {e}")
        raise AppError("standards_extraction_failed", f"Failed to extract standards: {str(e)}")
