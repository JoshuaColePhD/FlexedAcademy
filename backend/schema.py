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
    "required": ["name", "no_school", *DAY_CONTENT_FIELDS],
}

PLAN_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "week_of": {
            "type": "string",
            "description": "e.g. 'Week 11 — Oct 19-23, 2026'",
        },
        "days": {"type": "array", "items": DAY_JSON_SCHEMA},
    },
    "required": ["week_of", "days"],
}


def plan_schema_snippet() -> str:
    return json.dumps(PLAN_JSON_SCHEMA, indent=2)


def day_schema_snippet() -> str:
    return json.dumps(DAY_JSON_SCHEMA, indent=2)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class SchemaError(Exception):
    """A specific, showable reason the model's output can't become a document."""

    def __init__(self, code: str, message: str, *, path: str = "", hint: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.hint = hint

    def payload(self) -> dict:
        body = {"code": self.code, "message": self.message}
        if self.path:
            body["path"] = self.path
        if self.hint:
            body["hint"] = self.hint
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
        # "No School" and blanks the rest.
        return {"name": name, "no_school": True}, warnings

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


def validate_plan(plan: object) -> tuple[dict, list[str]]:
    """Validate a whole week. Returns (normalized_plan, warnings).

    Raises SchemaError with a distinct `code` per failure so the frontend can
    say something better than "500".
    """
    if not isinstance(plan, dict):
        raise SchemaError("not_an_object", "Expected a JSON object at the top level.")

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
