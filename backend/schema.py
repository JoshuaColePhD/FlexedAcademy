"""The lesson-plan schema — one definition, used by the prompt, the validator,
and the eval harness, so they cannot drift apart again.

This mirrors template `florence-docx-v2`, which is what
Skills/build-lesson-plan/scripts/build_lesson_plan.py actually reads. Note that
the "Lesson Plan Template Spec" in the workspace CLAUDE.md documents the RETIRED
v1 template (8 rows, with Curriculum/Resources and "What will learning look
like?"). v2 is 7 rows x 6 cols and has neither. Build against the script.

Three constraints below are not obvious from the JSON and were read out of the
builder's own code:

1. `engagement_strategy` must be a LIST. The builder renders it as a Word
   dropdown content control (`w:dropDownList`) whose selected value must match
   one of ENGAGEMENT_OPTIONS, or Word shows an off-list value.
2. `learning_targets` / `standards` / `act_alignment` go through the builder's
   `write_plain()`, which emits a SINGLE paragraph. Embedded newlines are
   silently discarded by python-docx. Only do_now/during/assessment are split on
   newlines. So we normalize newlines out of the single-line fields and warn.
3. The builder does `days = {d["name"]: d}` then `days.get(name, {"no_school":
   True})`. A misspelled day name therefore renders as a plausible-looking "No
   School" column instead of failing. That has to be a hard validation error
   here, because the document would otherwise look fine and be wrong.
"""
from __future__ import annotations

import json
import re

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]

# Mirrored from the canonical builder. docx_build.assert_builder_contract()
# checks at startup that these still match — the builder is outside this repo.
ENGAGEMENT_OPTIONS = [
    "Cold Call",
    "Equity Sticks",
    "Think/Pair/Share",
    "Small Groups",
    "A/B Partners",
    "Write 1st, Talk 2nd",
    "Gallery Walk",
    "Rally Coach",
]

# Fields the builder renders as one paragraph — newlines are lost.
SINGLE_LINE_FIELDS = ("learning_targets", "standards", "act_alignment")
# Fields the builder splits on newlines.
MULTILINE_FIELDS = ("do_now", "during", "assessment")

DAY_CONTENT_FIELDS = SINGLE_LINE_FIELDS + ("engagement_strategy",) + MULTILINE_FIELDS

# Identity fields are injected server-side from the settings record, never
# authored by the model. See prompts.py.
PLAN_IDENTITY_FIELDS = ("teacher", "course", "period")


# ---------------------------------------------------------------------------
# OpenAI Structured Outputs schemas
#
# strict mode requires: every property listed in "required", and
# additionalProperties:false on every object. minItems/maxItems are NOT
# supported, so "exactly 5 days" stays validate_plan()'s job.
# ---------------------------------------------------------------------------

DAY_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "name": {"type": "string", "enum": DAY_NAMES},
        "no_school": {"type": "boolean"},
        # SCREEN ONLY — the district template has no such cell and the builder
        # never reads it. It exists because the week strip in the chat has five
        # columns about 90px wide, and "I can identify how a writer's ethos
        # shapes an audience's trust" is not a thing you can read in one. A
        # teacher scanning a built week wants "Ethos & audience".
        "title": {
            "type": "string",
            "description": "Two to four words naming the day's focus, e.g. 'Ethos & audience' or 'Irony workshop'. Title case off. Not a sentence.",
        },
        "learning_targets": {
            "type": "string",
            "description": 'Single line, must start with "I can" followed by a Bloom\'s taxonomy verb matched to the Depth of Knowledge (DOK). No newlines.',
        },
        "standards": {
            "type": "string",
            "description": "Standard code(s) and text, e.g. '2.A -- Describe the rhetorical situation'. Single line.",
        },
        "act_alignment": {
            "type": "string",
            "description": "ACT English/Writing code(s), e.g. 'TOD 502; ORG 403'. Single line. Empty string if none grounded.",
        },
        "engagement_strategy": {
            "type": "array",
            "items": {"type": "string", "enum": ENGAGEMENT_OPTIONS},
            "description": "One or more strategies from the fixed district list.",
        },
        "do_now": {"type": "string", "description": "Bell work, ~5 minutes."},
        "during": {
            "type": "string",
            "description": "Full instructional narrative for the period: explicit instruction, group work, independent work. No sub-labels.",
        },
        "assessment": {"type": "string", "description": "The evidence or artifact produced."},
    },
    # Structured Outputs' strict mode requires every declared property to be
    # required, so `title` is required OF THE MODEL. validate_day still treats
    # it as optional, because plans generated before it existed do not have one
    # and must keep opening.
    "required": ["name", "no_school", "title", *DAY_CONTENT_FIELDS],
}

PLAN_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "week_of": {
            "type": "string",
            "description": (
                "e.g. 'Week 11 — Oct 19-23, 2026'. If the calendar context says no real dates "
                "are on file for this school, use the week NUMBER alone (e.g. 'Week 11') — "
                "never invent a date range."
            ),
        },
        "days": {"type": "array", "items": DAY_JSON_SCHEMA},
    },
    "required": ["week_of", "days"],
}


# ---------------------------------------------------------------------------
# Quiz — grounded in an ALREADY-BUILT plan, not a fresh retrieval
#
# generate_quiz (llm.py) hands the model the plan's own plan_json as its only
# source material and forbids citing any standard not already in it — the
# quiz can only test what the week's grounding audit already verified, never
# a code the retrieval step never actually surfaced. No new retrieval call,
# no new way for a code to be wrong.
#
# One flat question shape covers all four types (Structured Outputs' strict
# mode requires every declared property present regardless of type, same as
# DAY_JSON_SCHEMA above) rather than a oneOf/anyOf per type — the API does
# not support oneOf inside a JSON Schema response_format, only a single flat
# object. qti_build.py reads whichever fields `type` actually uses and
# ignores the rest.
# ---------------------------------------------------------------------------

QUESTION_TYPES = ["multiple_choice", "true_false", "short_answer", "matching"]

QUESTION_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "type": {"type": "string", "enum": QUESTION_TYPES},
        "prompt": {"type": "string", "description": "The question text, one to two sentences."},
        "standard_code": {
            "type": "string",
            "description": "The exact standard code (as written in the plan) this question tests, or '' if it tests general comprehension rather than one specific code.",
        },
        "choices": {
            "type": "array",
            "items": {"type": "string"},
            "description": "multiple_choice only: 3-5 answer options, in the order they should be shown. [] for every other type.",
        },
        "correct_index": {
            "type": "integer",
            "description": "multiple_choice only: 0-based index into `choices` of the correct answer. -1 for every other type.",
        },
        "correct_bool": {
            "type": "boolean",
            "description": "true_false only: whether the statement in `prompt` is true. Always include; ignored for every other type.",
        },
        "accepted_answers": {
            "type": "array",
            "items": {"type": "string"},
            "description": "short_answer only: exact-match acceptable answers — include obvious capitalization/wording variants, since Canvas grades this literally. [] for every other type.",
        },
        "pairs": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "term": {"type": "string"},
                    "match": {"type": "string"},
                },
                "required": ["term", "match"],
            },
            "description": "matching only: 3-6 term/match pairs. [] for every other type.",
        },
    },
    "required": ["type", "prompt", "standard_code", "choices", "correct_index", "correct_bool", "accepted_answers", "pairs"],
}

QUIZ_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string", "description": "e.g. 'Week 11 Quiz — Voice, Tone & Rhetorical Devices'"},
        "questions": {"type": "array", "items": QUESTION_JSON_SCHEMA},
    },
    "required": ["title", "questions"],
}


# ---------------------------------------------------------------------------
# Calendar intake — parsing a teacher-uploaded school calendar into the exact
# week-dict shape schoolcal.py's own hand-curated parser produces
# ({week, start, end, notes, no_school, closures}), so a confirmed submission
# is indistinguishable from a real calendar file to every downstream reader
# (week_for, label_for, week_days, week_board).
# ---------------------------------------------------------------------------

CALENDAR_WEEK_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "week": {"type": "integer", "description": "Sequential teaching-week number, starting at 1."},
        "start": {
            "type": ["string", "null"],
            "description": "ISO date (YYYY-MM-DD) the week starts (usually a Monday). Null only if genuinely not stated in the source.",
        },
        "end": {
            "type": ["string", "null"],
            "description": "ISO date (YYYY-MM-DD) the week ends (usually a Friday). Null only if genuinely not stated in the source.",
        },
        "notes": {"type": "string", "description": "A holiday/break/testing note for this week, or ''."},
        "no_school": {"type": "boolean", "description": "True when the whole week is a break/closure."},
        "closures": {"type": "boolean", "description": "True when any single day in the week is closed."},
    },
    "required": ["week", "start", "end", "notes", "no_school", "closures"],
}

CALENDAR_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "weeks": {"type": "array", "items": CALENDAR_WEEK_JSON_SCHEMA},
    },
    "required": ["weeks"],
}


class QuizSchemaError(Exception):
    """A question the model wrote doesn't match what its own `type` needs —
    e.g. multiple_choice with an empty `choices`, or a correct_index outside
    `choices`. Caught where the quiz is built, same as SchemaError for a plan
    day: a structurally invalid question would either crash the QTI writer
    or silently produce a Canvas item with no right answer."""


def validate_quiz(quiz: dict) -> list[str]:
    """Returns warnings; raises QuizSchemaError only for a question qti_build.py
    could not render at all (grading a QTI item with no correct answer marked
    is worse than dropping it, so those are fatal here rather than warned)."""
    warnings: list[str] = []
    questions = quiz.get("questions") or []
    if not questions:
        raise QuizSchemaError("The quiz has no questions.")
    for i, q in enumerate(questions, 1):
        label = f"Q{i} ({q.get('type')})"
        qtype = q.get("type")
        if qtype == "multiple_choice":
            choices = q.get("choices") or []
            idx = q.get("correct_index")
            if len(choices) < 2:
                raise QuizSchemaError(f"{label}: fewer than 2 choices.")
            if not isinstance(idx, int) or not (0 <= idx < len(choices)):
                raise QuizSchemaError(f"{label}: correct_index {idx!r} doesn't point into choices.")
        elif qtype == "short_answer":
            if not (q.get("accepted_answers") or []):
                raise QuizSchemaError(f"{label}: no accepted_answers.")
        elif qtype == "matching":
            pairs = q.get("pairs") or []
            if len(pairs) < 2:
                raise QuizSchemaError(f"{label}: fewer than 2 pairs.")
        elif qtype == "true_false":
            if not isinstance(q.get("correct_bool"), bool):
                raise QuizSchemaError(f"{label}: correct_bool is not a real boolean.")
        else:
            raise QuizSchemaError(f"{label}: unknown question type {qtype!r}.")
        if not (q.get("standard_code") or "").strip():
            warnings.append(f"{label}: no standard cited.")
    return warnings


# ---------------------------------------------------------------------------
# Field-scoped revision
#
# In-cell tweaking rewrites ONE cell. Regenerating the whole day for "make the
# Do Now a quickwrite" also regenerates that day's standards and engagement
# tags — which quietly re-rolls the grounding audit this app exists to
# guarantee. So a scoped revise names its field, the model returns only that
# field, and every sibling key stays byte-identical.
# ---------------------------------------------------------------------------

# The only keys a teacher may scope a revision to. Validated server-side: this
# string reaches a prompt as a schema key, so it is never taken on trust.
# `title` is in here even though it is screen-only — it is a cell a teacher can
# click in the week strip, and rewriting it must not regenerate the day.
REVISABLE_FIELDS = DAY_CONTENT_FIELDS + ("title",)

# Fields whose text can carry a standard code. Editing one of these can
# introduce a code retrieval never supplied, so these — and only these — force
# the retrieval + grounding audit to re-run. Everything else skips it; that is
# the entire point of the scope.
CODE_BEARING_FIELDS = ("standards", "act_alignment")


def field_json_schema(field: str) -> dict:
    """Structured-output schema for a single-field rewrite.

    Reuses the field's own definition out of DAY_JSON_SCHEMA rather than
    restating it, so a scoped rewrite and a whole-day rewrite cannot describe
    the same field differently.
    """
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {field: DAY_JSON_SCHEMA["properties"][field]},
        "required": [field],
    }


def plan_schema_snippet() -> str:
    return json.dumps(PLAN_JSON_SCHEMA, indent=2)


def day_schema_snippet() -> str:
    return json.dumps(DAY_JSON_SCHEMA, indent=2)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class SchemaError(Exception):
    """A specific, showable reason the model's output can't become a document.

    Every one of these — a duplicate day name, a missing field, truncated
    JSON — is a single-sample formatting slip from the model, the same shape
    as llm.py's stream_chat malformed_tool_call/empty_reply, where a second
    attempt usually just works. retryable defaults to True for exactly that
    reason; no call site below has to opt in individually.
    """

    def __init__(
        self, code: str, message: str, *, path: str = "", hint: str = "", retryable: bool = True
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.hint = hint
        self.retryable = retryable

    def payload(self) -> dict:
        body = {"code": self.code, "message": self.message}
        if self.path:
            body["path"] = self.path
        if self.hint:
            body["hint"] = self.hint
        if self.retryable:
            body["retryable"] = True
        return body


_WS = re.compile(r"\s+")


def _collapse(text: str) -> str:
    return _WS.sub(" ", text).strip()


def normalize_day(day: dict, warnings: list[str] | None = None) -> dict:
    """Coerce a day into exactly what the builder wants. Mutates a copy."""
    warnings = warnings if warnings is not None else []
    d = dict(day)
    name = d.get("name", "?")

    strategies = d.get("engagement_strategy")
    if isinstance(strategies, str):
        # v1 emitted a comma-joined string. Split it back apart rather than
        # handing the builder a value its dropdown can't match.
        d["engagement_strategy"] = [s.strip() for s in strategies.split(",") if s.strip()]
        warnings.append(f"{name}: engagement_strategy was a string; split into a list.")
    elif strategies is None:
        d["engagement_strategy"] = []

    for field in SINGLE_LINE_FIELDS:
        val = d.get(field)
        if isinstance(val, str) and "\n" in val:
            d[field] = _collapse(val)
            warnings.append(
                f"{name}: newlines in '{field}' were collapsed — the district "
                f"template renders that cell as a single paragraph and python-docx "
                f"would have dropped them silently."
            )
        elif isinstance(val, str):
            d[field] = val.strip()

    for field in MULTILINE_FIELDS:
        if isinstance(d.get(field), str):
            d[field] = d[field].strip()

    # Screen-only, and deliberately NOT in DAY_CONTENT_FIELDS: a plan from
    # before this field existed must still validate and still build.
    if isinstance(d.get("title"), str):
        d["title"] = _collapse(d["title"])

    return d


def validate_day(day: object, *, path: str = "day") -> tuple[dict, list[str]]:
    """Validate one day. Returns (normalized_day, warnings)."""
    if not isinstance(day, dict):
        raise SchemaError("day_not_an_object", f"Expected an object at {path}.", path=path)

    name = day.get("name")
    if name not in DAY_NAMES:
        raise SchemaError(
            "day_bad_name",
            f"Day name {name!r} is not one of {', '.join(DAY_NAMES)}.",
            path=f"{path}.name",
            hint="A misspelled day silently renders as a blank 'No School' column, so this is rejected rather than built.",
        )

    warnings: list[str] = []

    if day.get("no_school") is True:
        # Content is irrelevant for a no-school day; the builder stamps
        # "No School" and blanks the rest. The title survives, because the week
        # strip still wants to say WHY — "Pep rally" beats a blank cell.
        closed = {"name": name, "no_school": True}
        if str(day.get("title") or "").strip():
            closed["title"] = _collapse(str(day["title"]))
        return closed, warnings

    d = normalize_day(day, warnings)

    for field in DAY_CONTENT_FIELDS:
        if field not in d:
            raise SchemaError(
                "day_missing_field",
                f"{name} is missing '{field}'.",
                path=f"{path}.{field}",
            )

    for field in ("learning_targets", "during"):
        if not str(d.get(field, "")).strip():
            raise SchemaError(
                "day_empty_field",
                f"{name} has an empty '{field}'.",
                path=f"{path}.{field}",
            )

    lt = str(d["learning_targets"]).strip()
    if not lt.lower().startswith("i can"):
        raise SchemaError(
            "learning_target_prefix",
            f"{name}'s learning target must start with \"I can\" (got {lt[:40]!r}).",
            path=f"{path}.learning_targets",
            hint="The district template requires it.",
        )

    strategies = d["engagement_strategy"]
    if not isinstance(strategies, list) or not all(isinstance(s, str) for s in strategies):
        raise SchemaError(
            "engagement_not_list",
            f"{name}'s engagement_strategy must be a list of strings.",
            path=f"{path}.engagement_strategy",
        )
    if not strategies:
        raise SchemaError(
            "engagement_empty",
            f"{name} has no engagement strategy; the district template marks that field required.",
            path=f"{path}.engagement_strategy",
        )
    # Off-list values are a warning, not an error — the doc still builds, the
    # Word dropdown just shows a value that isn't in its list.
    unknown = [s for s in strategies if s not in ENGAGEMENT_OPTIONS]
    if unknown:
        warnings.append(
            f"{name}: engagement strategy {', '.join(repr(u) for u in unknown)} "
            f"is not in the district dropdown list; Word will show it as an off-list value."
        )

    d["no_school"] = False
    return d, warnings


# python-docx writes straight into OOXML, and XML 1.0 cannot represent most
# control characters at all — it raises "All strings must be XML compatible" and
# the whole build dies.
#
# This is not hypothetical. A revised plan came back with week_of containing
# U+0014, which is a mangled U+2014 em dash: the model dropped the high byte of
# "—". The .docx build then failed in a BACKGROUND task, after update_plan had
# already cleared docx_path — so the plan was left permanently undownloadable
# while the UI cheerfully reported "still generating" forever.
#
# Where a control character is the low byte of a punctuation mark a model
# commonly mangles, it is restored; everything else non-printable is dropped.
# Tab, newline and carriage return are legal XML and are kept.
_MANGLED = {
    "\x13": "–",  # U+2013 en dash
    "\x14": "—",  # U+2014 em dash
    "\x18": "‘",  # U+2018
    "\x19": "’",  # U+2019
    "\x1c": "“",  # U+201C
    "\x1d": "”",  # U+201D
    "\x26": "…",  # U+2026 — only reached for the control char, not for "&"
}


def _clean_text(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        if o in (0x09, 0x0A, 0x0D) or o >= 0x20:
            out.append(ch)  # legal XML, including a literal "&"
        elif ch in _MANGLED:
            out.append(_MANGLED[ch])
        # else: dropped
    return "".join(out)


def _clean(obj):
    """Recursively strip XML-illegal characters from every string in a plan."""
    if isinstance(obj, str):
        return _clean_text(obj)
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def validate_plan(plan: object) -> tuple[dict, list[str]]:
    """Validate a whole week. Returns (normalized_plan, warnings).

    Raises SchemaError with a distinct `code` per failure so the frontend can
    say something better than "500".
    """
    if not isinstance(plan, dict):
        raise SchemaError("not_an_object", "Expected a JSON object at the top level.")

    # Before anything else looks at the strings — every path into a plan
    # (generate, revise_day, revise) comes through here, which is the point.
    plan = _clean(plan)

    if not str(plan.get("week_of", "")).strip():
        raise SchemaError("missing_field", "Missing 'week_of'.", path="week_of")

    days = plan.get("days")
    if not isinstance(days, list):
        raise SchemaError("days_not_a_list", "'days' must be a list.", path="days")

    if len(days) != len(DAY_NAMES):
        raise SchemaError(
            "days_wrong_count",
            f"Expected {len(DAY_NAMES)} days (Monday-Friday), got {len(days)}.",
            path="days",
            hint="Regenerate — the model returned a partial week.",
        )

    warnings: list[str] = []
    out_days = []
    seen: list[str] = []
    for i, raw in enumerate(days):
        d, w = validate_day(raw, path=f"days[{i}]")
        warnings.extend(w)
        if d["name"] in seen:
            raise SchemaError(
                "days_duplicate_name",
                f"{d['name']} appears more than once.",
                path=f"days[{i}].name",
            )
        seen.append(d["name"])
        out_days.append(d)

    missing = [n for n in DAY_NAMES if n not in seen]
    if missing:
        raise SchemaError(
            "days_wrong_names",
            f"Missing day(s): {', '.join(missing)}.",
            path="days",
            hint="A missing day would render as a blank 'No School' column, so this is rejected.",
        )

    # Builder keys days by name, but keep them in weekday order anyway so the
    # stored plan_json reads correctly and the UI doesn't have to sort.
    out_days.sort(key=lambda d: DAY_NAMES.index(d["name"]))

    normalized = {"week_of": str(plan["week_of"]).strip(), "days": out_days}
    # Pass through identity fields if a caller already injected them.
    for field in PLAN_IDENTITY_FIELDS:
        if plan.get(field):
            normalized[field] = plan[field]
    return normalized, warnings


def with_identity(plan: dict, *, teacher: str, course: str, period: str) -> dict:
    """Stamp the teacher's identity onto a validated plan.

    The model does not author these — they came from the settings record. This
    is why the app was previously hardcoded to "Josh Cole" / "3rd period" in the
    prompt itself.
    """
    out = dict(plan)
    out["teacher"] = teacher
    out["course"] = course
    out["period"] = period
    return out


def loads_lenient(text: str) -> dict:
    """Parse model JSON, tolerating markdown fences.

    Structured Outputs makes fences impossible, so this is only a backstop for
    the streaming accumulator and for older stored payloads. It replaces four
    separate copy-pasted fence-stripping blocks.
    """
    s = text.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        if s.endswith("```"):
            s = s[:-3]
        s = s.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        raise SchemaError(
            "truncated_json",
            f"The model's output was not valid JSON ({e.msg} at line {e.lineno}).",
            hint="This usually means the response was cut off. Try again.",
        ) from e
