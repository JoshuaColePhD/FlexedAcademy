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

# These are required for newly generated plans so templates which need the
# fuller Weeden form have real content for every row.  They remain safely
# optional for plans created before this addition; normalize_day() supplies an
# empty value for those legacy documents before validation.
WEEDEN_SECTION_FIELDS = (
    "vocabulary",
    "reteach_small_groups",
    "cross_curricular_connection",
)

DAY_CONTENT_FIELDS = SINGLE_LINE_FIELDS + ("engagement_strategy",) + MULTILINE_FIELDS + WEEDEN_SECTION_FIELDS

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
        "vocabulary": {
            "type": "string",
            "description": "Key vocabulary students will explicitly learn, practice, or apply. Use 'N/A' only when no vocabulary instruction fits.",
        },
        "reteach_small_groups": {
            "type": "string",
            "description": "Targeted reteach, intervention, or small-group support based on likely misconceptions or formative evidence.",
        },
        "cross_curricular_connection": {
            "type": "string",
            "description": "A meaningful connection to another subject, real-world application, or integrated literacy/science/social-studies task.",
        },
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


# ---------------------------------------------------------------------------
# Template intake — the LLM's read of a school's uploaded lesson-plan
# template, given template_intake.py's deterministic structural extraction
# (headings/tables/fonts) as input, never the raw file. `source_evidence` is
# required on every section specifically so template_intake.py can check it
# against the extraction it was given — a name the model invents rather than
# quotes is the one thing Structured Outputs' schema can't catch on its own,
# since "this string must appear verbatim in some other text" isn't
# expressible as JSON Schema.
# ---------------------------------------------------------------------------

TEMPLATE_SECTION_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "name": {
            "type": "string",
            "description": "Short name for this section/field, e.g. 'Header table', 'Learning objectives', 'Standards alignment'.",
        },
        "description": {
            "type": "string",
            "description": "What content this section is meant to hold, in plain language, for someone building a document generator from it.",
        },
        "source_evidence": {
            "type": "string",
            "description": (
                "The exact heading text, table header cell, or label — copied verbatim, character-for-character, "
                "from the structural extraction you were given — that this section is grounded in. Never a "
                "paraphrase and never invented; if nothing in the extraction supports this section, do not include it."
            ),
        },
        "repeats_per_entry": {
            "type": "boolean",
            "description": "True if this section appears once per day/lesson/week entry (e.g. one table row per day) rather than once for the whole document.",
        },
    },
    "required": ["name", "description", "source_evidence", "repeats_per_entry"],
}

TEMPLATE_ANALYSIS_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "sections": {"type": "array", "items": TEMPLATE_SECTION_JSON_SCHEMA},
        "unclear_or_ambiguous": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Anything in the template whose purpose or expected format wasn't clear enough to map confidently — flag it for a human rather than guessing.",
        },
        "overall_confidence": {
            "type": "number",
            "description": "0.0-1.0 self-rated confidence that `sections` correctly and completely describes this template's structure.",
        },
        "recommended_for_auto_use": {
            "type": "boolean",
            "description": "True only if confident enough that a builder script could be written from `sections` alone, without a human re-reading the original file.",
        },
    },
    "required": ["sections", "unclear_or_ambiguous", "overall_confidence", "recommended_for_auto_use"],
}


# A second, independently-framed pass auditing analyze_template_structure's
# own proposed sections against the same extraction — see
# llm.verify_template_sections and template_intake.py's own comment on why
# this is a skeptical review of specific claims, not a re-run of the same
# prompt (which would likely just repeat the same mistake).
TEMPLATE_VERIFICATION_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Must exactly match the name of one of the proposed sections given below.",
                    },
                    "accurate": {
                        "type": "boolean",
                        "description": "True only if this section's description genuinely matches what its cited evidence shows — not merely that the evidence exists.",
                    },
                    "reason": {"type": "string", "description": "One sentence justifying the verdict."},
                },
                "required": ["name", "accurate", "reason"],
            },
        },
    },
    "required": ["verdicts"],
}


# ---------------------------------------------------------------------------
# Builder codegen — turning a template's already-verified `analysis.sections`
# (TEMPLATE_ANALYSIS_JSON_SCHEMA above) into a declarative layout spec that
# backend/builder/generic_renderer.py can render, plus the schema for the
# vision judge that verifies a rendered sample against the real uploaded
# template before any of this reaches a teacher. See backend/builder_gen.py's
# module docstring (once built) for the full pipeline this feeds.
#
# `field` below is a closed JSON-Schema enum drawn from DAY_CONTENT_FIELDS —
# not a free-text string — specifically so a hallucinated or misspelled field
# reference is structurally impossible for Structured Outputs to emit, the
# same way TEMPLATE_SECTION_JSON_SCHEMA's `source_evidence` is checked
# against the extraction it must quote, just enforced one layer earlier here.
# ---------------------------------------------------------------------------

_BUILDER_DAY_FIELD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "field": {
            "type": "string",
            "enum": list(DAY_CONTENT_FIELDS),
            "description": "Which day-content field this cell renders. Must be one of the app's real fields — never invented.",
        },
        "source_section_name": {
            "type": "string",
            "description": "The `name` of the analysis section (from the template analysis you were given) that grounds this mapping.",
        },
    },
    "required": ["field", "source_section_name"],
}

_BUILDER_MULTI_FIELD_BLOCK_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "field": {"type": "string", "enum": list(DAY_CONTENT_FIELDS)},
                    "label": {"type": "string", "description": "Bold sub-label shown before this field's text, e.g. 'Do Now:'."},
                },
                "required": ["field", "label"],
            },
        },
        "source_section_name": {
            "type": "string",
            "description": "The `name` of the analysis section that groups these fields into one cell.",
        },
    },
    "required": ["fields", "source_section_name"],
}

_BUILDER_HEADER_CELL_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "col_span": {"type": "integer", "description": "How many table columns this cell spans (merged). 1 if not merged."},
        "text_template": {
            "type": "string",
            "description": (
                "Literal text for this header cell. May reference {teacher}, {course}, {period}, or {week_of} "
                "using exactly that Python str.format() syntax — no other placeholders are supported."
            ),
        },
        "shade_hex": {"type": "string", "description": "6-digit hex fill color for this cell, no leading #, e.g. '6d9eeb'."},
        "bold": {"type": "boolean"},
        "align": {"type": "string", "enum": ["left", "center", "right"]},
    },
    "required": ["col_span", "text_template", "shade_hex", "bold", "align"],
}

_BUILDER_COLUMN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "role": {"type": "string", "enum": ["label", "day"]},
        "day_index": {
            "type": ["integer", "null"],
            "description": "0-4 (Monday-Friday, per schema.DAY_NAMES) for a role='day' column; null for role='label'.",
        },
        "width_dxa": {"type": "integer", "description": "Column width in twentieths of a point (DXA)."},
    },
    "required": ["role", "day_index", "width_dxa"],
}

_BUILDER_BODY_ROW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "label": {"type": "string", "description": "Text shown in this row's label column, e.g. 'Standards:'."},
        "shade_label_hex": {"type": "string"},
        "shade_body_hex": {"type": "string"},
        "control_type": {"type": "string", "enum": ["plain", "dropdown"]},
        "cell_source": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "kind": {"type": "string", "enum": ["day_field", "multi_field_block"]},
                "day_field": _BUILDER_DAY_FIELD_SCHEMA,
                "multi_field_block": _BUILDER_MULTI_FIELD_BLOCK_SCHEMA,
            },
            "required": ["kind", "day_field", "multi_field_block"],
            "description": (
                "Exactly one of day_field/multi_field_block is meaningful, selected by `kind` — the other must "
                "still be present per strict-mode requirements but is ignored at render time."
            ),
        },
        "dropdown_options_ref": {
            "type": ["string", "null"],
            "enum": ["ENGAGEMENT_OPTIONS", None],
            "description": "Required (non-null) only when control_type is 'dropdown'.",
        },
        "no_school_text": {
            "type": ["string", "null"],
            "description": "Text centered in this cell for a day marked no_school (e.g. 'No School'); null to leave it blank.",
        },
    },
    "required": [
        "label", "shade_label_hex", "shade_body_hex", "control_type",
        "cell_source", "dropdown_options_ref", "no_school_text",
    ],
}

BUILDER_LAYOUT_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "page": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "orientation": {"type": "string", "enum": ["landscape", "portrait"]},
                "width_dxa": {"type": "integer"},
                "height_dxa": {"type": "integer"},
                "margin_dxa": {"type": "integer"},
            },
            "required": ["orientation", "width_dxa", "height_dxa", "margin_dxa"],
        },
        "table": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "columns": {"type": "array", "items": _BUILDER_COLUMN_SCHEMA},
                "header_rows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {"cells": {"type": "array", "items": _BUILDER_HEADER_CELL_SCHEMA}},
                        "required": ["cells"],
                    },
                },
                "body_rows": {"type": "array", "items": _BUILDER_BODY_ROW_SCHEMA},
            },
            "required": ["columns", "header_rows", "body_rows"],
        },
    },
    "required": ["page", "table"],
}


# The vision judge comparing a rendered synthetic-fixture sample against the
# real uploaded template's own rendering — see llm.judge_builder_render and
# backend/builder/codegen.py's attempt loop. Run twice independently per
# attempt (never averaged/cached) — mirrors verify_template_sections' own
# "a second, independently-framed pass" philosophy, applied to a brand-new,
# unproven trust boundary (no vision-judge track record exists yet).
BUILDER_RENDER_JUDGE_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "structural_match": {
            "type": "boolean",
            "description": "True only if the rendered sample has the same table shape (row/column count and order, header labels) as the original template.",
        },
        "per_field_checks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "field": {"type": "string", "description": "Which fixture value this check is about, e.g. 'MONDAY-STANDARDS-TEST'."},
                    "correct_cell": {"type": "boolean", "description": "True only if this value appears in the cell a human would expect for it."},
                    "issue": {"type": ["string", "null"], "description": "What's wrong, if correct_cell is false; null otherwise."},
                },
                "required": ["field", "correct_cell", "issue"],
            },
        },
        "visual_defects": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Any rendering defect: text overflow/truncation, missing shading, wrong orientation, garbled or corrupt render. Empty if none.",
        },
        "pass": {
            "type": "boolean",
            "description": "True only if structural_match is true, every per_field_checks entry has correct_cell true, and visual_defects is empty.",
        },
        "confidence": {"type": "number", "description": "0.0-1.0 self-rated confidence in this verdict."},
        "reasoning": {"type": "string", "description": "Brief explanation of the verdict, referencing anything specific that failed."},
    },
    "required": ["structural_match", "per_field_checks", "visual_defects", "pass", "confidence", "reasoning"],
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
            if len(choices) < 3:
                raise QuizSchemaError(f"{label}: fewer than 3 choices.")
            if not isinstance(idx, int) or not (0 <= idx < len(choices)):
                raise QuizSchemaError(f"{label}: correct_index {idx!r} doesn't point into choices.")
            if any(c.strip().lower() in ("all of the above", "none of the above") for c in choices):
                warnings.append(f"{label}: uses 'all/none of the above', which is a weak distractor pattern.")
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

    # New plans have these fields because the strict response schema requires
    # them.  Old saved plans predate them and must still open, revise, and
    # rebuild without a migration of every historical JSON payload.
    for field in WEEDEN_SECTION_FIELDS:
        d.setdefault(field, "")

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

    # act_alignment is deliberately excluded: a course with no companion ACT
    # standards block is CORRECTLY blank there on every day (see
    # retrieval.act_sections_for's own comment) — a course-blind hard check
    # here would reject valid plans. Its narrower, course-aware version of
    # this same check lives in retrieval.audit_grounding instead, which knows
    # whether ACT alignment was expected for this specific subject.
    for field in ("learning_targets", "standards", "do_now", "during", "assessment"):
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
        s = s.removesuffix("```")
        s = s.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        raise SchemaError(
            "truncated_json",
            f"The model's output was not valid JSON ({e.msg} at line {e.lineno}).",
            hint="This usually means the response was cut off. Try again.",
        ) from e
