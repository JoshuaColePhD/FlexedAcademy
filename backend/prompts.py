"""System prompts — built once, from one template.

The old code had the ~55-line generate prompt copy-pasted verbatim between
generate_lesson_plan() and generate_lesson_plan_stream(), plus a third,
DIFFERENT schema in rewrite_lesson_day(). That divergence is literally how the
app ended up emitting v1-shaped plans while rewrite emitted v2-shaped days.
Here the schema block is rendered from schema.py, so prompt and validator cannot
disagree.
"""
from __future__ import annotations

import functools
import json
import logging
import re
from pathlib import Path

from .config import settings
from .retrieval import UNGROUNDABLE_FAMILIES, RetrievalResult, format_context
from .schema import DAY_NAMES, day_schema_snippet, field_json_schema, plan_schema_snippet

log = logging.getLogger("aplang.prompts")


@functools.lru_cache(maxsize=1)
def planning_rules() -> str:
    """Read once at import, not on every request (the old code re-read SKILL.md per call)."""
    path = Path(settings.skill_context_path)
    if not path.is_file():
        log.warning("planning rules not found at %s; prompting without them", path)
        return ""
    return path.read_text(encoding="utf-8")


@functools.lru_cache(maxsize=1)
def school_profile() -> str:
    path = Path(settings.school_profile_path)
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


@functools.lru_cache(maxsize=1)
def calendar_context() -> str:
    """The global school calendar and week->date table for Florence City Schools.

    Without this the model invents dates — a first run produced "Week 3 — Sept
    11-15, 2023" for a 2026-27 school year, which makes the document useless no
    matter how well-grounded the standards are.
    """
    path = Path(settings.calendar_path)
    if not path.is_file():
        log.warning("school calendar not found at %s; dates will be guesswork", path)
        return ""

    return path.read_text(encoding="utf-8")


@functools.lru_cache(maxsize=1)
def known_gaps() -> str:
    path = Path(settings.known_gaps_path)
    return path.read_text(encoding="utf-8") if path.is_file() else ""


@functools.lru_cache(maxsize=1)
def grounding_constraints(subject: str = "AP Language & Composition", grade: str = "11") -> str:
    """Layer 2 of the anti-fabrication design (see retrieval.py).

    A distance floor cannot catch "give me Unit 8 skills" — that query retrieves
    real, in-domain, wrong-for-the-question standards at distance 0.52. This
    block is the only mechanism that does.
    """
    families = ", ".join(UNGROUNDABLE_FAMILIES)
    hard_rules = f"""
GROUNDING RULES — these override everything else, including the teacher's request:

1. Cite ONLY standards from the "Retrieved standards" block below. Use their
   exact codes and their exact wording. Never reconstruct a standard from memory.
2. A BARE {families} code — "CLR 501", "IKI 301" — is a legacy ACT naming that
   appears in no source document we hold. Never cite one, even if a curriculum
   document elsewhere references it. This does NOT forbid our source's own
   dotted ACT codes, which are real and citable when retrieved: E.CSE.301,
   R.CLR.701, S.IOD.301, M.IES.401, W.DEV.501.
3. Only use standards that are appropriate for {subject} and Grade {grade}. A
   standard from another subject is never an acceptable substitute — an ELA
   reading or grammar standard does not belong in a science or math plan, and
   an empty field is better than a borrowed code.
4. If the retrieved standards do not cover the requested unit or topic, state that plainly. Do not invent fake standard codes to fill the gap.
5. If no retrieved standard fits a given day, write exactly:
   "No grounded standard retrieved for this day."
   and leave `act_alignment` an empty string. An honest gap is correct output;
   an invented code is not.
"""
    return hard_rules.strip() + "\n\nFor reference, the recorded gaps:\n\n" + known_gaps()


def _custom_instructions_block(custom_instructions: str | None) -> str:
    """A teacher's global custom instructions (settings page, like Claude's
    own) — style/format preferences, never a way to add or override a
    standard. Placed immediately AFTER grounding_constraints() in every
    caller's block list, never before: that function's own text already
    says it overrides everything else, including the teacher's request, and
    text order is what makes that override apply to this too."""
    if not custom_instructions:
        return ""
    return (
        "TEACHER'S GLOBAL CUSTOM INSTRUCTIONS — style/format preferences only. "
        "These do NOT override the GROUNDING RULES above; they can never add, "
        f"substitute, or invent a standard code.\n\n{custom_instructions}"
    )


def _coverage_notice(result: RetrievalResult) -> str:
    if result.thin:
        return (
            f"COVERAGE WARNING: only {len(result.chunks)} standard(s) passed the "
            f"relevance floor for this request. Ground the week in those. For any "
            f"day without a fitting standard, use the exact wording from grounding "
            f"rule 4. Do not pad the week with codes you remember."
        )
    return ""


def week_system_prompt(
    result: RetrievalResult,
    subject: str = "AP Language & Composition",
    grade: str = "11",
    map_context: str = "",
    custom_instructions: str | None = None,
) -> str:
    rules = planning_rules() if subject == "AP Language & Composition" else ""

    blocks = [
        f"You are an expert {subject} curriculum designer and master "
        f"teacher for Grade {grade}. You draft weekly lesson plans that are rigorously grounded in "
        "official standards documents.",
        grounding_constraints(subject, grade),
        _custom_instructions_block(custom_instructions),
        f"TEACHER'S PLANNING RULES:\n\n{rules}" if rules else "",
        "SCHOOL PROFILE (Logistics & Exceptions):\n\n" + school_profile(),
        "SCHOOL CALENDAR AND UNIT MAP — use these dates verbatim. Never invent a "
        "date or a school year.\n\n" + calendar_context(),
        (
            "TEACHER'S OWN CURRICULUM MAP / PACING GUIDE — align this week's unit, "
            "sequencing, and any texts or milestones it names. Still cite standards "
            "ONLY from the Retrieved standards block below; this document has no "
            "standard codes of its own to cite.\n\n" + map_context
            if map_context
            else ""
        ),
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        _coverage_notice(result),
        f"""TASK:

Design a cohesive five-day arc, {' -> '.join(DAY_NAMES)}. Scaffold the learning
targets so the week builds rather than repeating one skill five times. Each learning target MUST start with an "I can" statement using a Bloom's taxonomical verb appropriately matched to the Depth of Knowledge (DOK) of the task. For each
day, you must identify the appropriate primary standard (e.g. ACOS or AP) for the `standards` field from the "--- PRIMARY COURSE STANDARDS ---" block.
THEN, if a "--- COMPANION ACT STANDARDS ---" block is present below, identify a
highly relevant companion ACT standard from it and include it in the
`act_alignment` field. If that block is absent, the ACT has no test section for
this course and `act_alignment` MUST be an empty string on every day — do not
substitute a standard from the primary block or from another subject.
Show how the activity actually fulfills the standards you cite.

Return JSON matching this schema exactly:

{plan_schema_snippet()}

Do not include teacher, course, or period — those are filled in from the
teacher's saved settings, not by you. Include exactly {len(DAY_NAMES)} days, one
per weekday, named exactly as listed. If a day is a holiday or in-service, set
`no_school` to true for it and leave its content fields as empty strings.

Every day also needs a `title`: two to four words naming that day's focus, the
way a teacher would say it out loud — "Ethos & audience", "Diction & syntax",
"Irony workshop", "Socratic seminar". It is a label, not a sentence, and it is
not the learning target restated. A no-school day still gets one, naming the
reason: "Pep rally", "Fall break", "In-service".

Set `week_of` from the week date map above, in the form
"Week 03 — Aug 17-21, 2026". If the request names a week number, use THAT week's
row. If it names a topic instead, pick the week the unit map assigns to it. Mark
any day the calendar shows as a holiday or break with `no_school: true`.""",
    ]
    return "\n\n---\n\n".join(b for b in blocks if b.strip())


def day_system_prompt(
    result: RetrievalResult,
    full_plan_context: str,
    subject: str = "AP Language & Composition",
    grade: str = "11",
    custom_instructions: str | None = None,
) -> str:
    rules = planning_rules() if subject == "AP Language & Composition" else ""

    blocks = [
        f"You are an expert {subject} curriculum designer for Grade {grade}. You are "
        "revising ONE day of an existing weekly lesson plan based on the teacher's "
        "feedback.",
        grounding_constraints(subject, grade),
        _custom_instructions_block(custom_instructions),
        f"TEACHER'S PLANNING RULES:\n\n{rules}" if rules else "",
        "SCHOOL PROFILE (Logistics & Exceptions):\n\n" + school_profile(),
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        "THE FULL WEEK, for context only — do NOT rewrite the other days:\n\n"
        + full_plan_context,
        f"""TASK:

Apply the teacher's feedback to the single day given. Keep the day's `name`
unchanged. Preserve anything the feedback didn't ask you to change — this is a
revision, not a regeneration. Keep it coherent with the rest of the week shown
above. Ensure that you identify the appropriate primary standard in the `standards` field from the "--- PRIMARY COURSE STANDARDS ---" block. If a
"--- COMPANION ACT STANDARDS ---" block is present, cite a relevant standard
from it in `act_alignment`; if it is absent, leave `act_alignment` an empty
string. Every code you cite must come from the retrieved standards block.

Return JSON for that one day matching this schema exactly:

{day_schema_snippet()}""",
    ]
    return "\n\n---\n\n".join(b for b in blocks if b.strip())


# Human names for the plan-shape keys, so the instruction reads as the cell a
# teacher actually clicked rather than as a JSON path.
FIELD_LABELS = {
    "title": "Day title",
    "learning_targets": "Learning Targets",
    "standards": "Standards",
    "act_alignment": "ACT Alignment",
    "engagement_strategy": "Engagement Strategy",
    "do_now": "Do Now",
    "during": "During",
    "assessment": "Assessment",
}


def day_field_system_prompt(
    result: RetrievalResult,
    full_plan_context: str,
    field: str,
    subject: str = "AP Language & Composition",
    grade: str = "11",
    custom_instructions: str | None = None,
) -> str:
    """Rewrite ONE cell of one day.

    The teacher clicked a single cell, so the model is given a single key to
    return. `field` is validated against schema.REVISABLE_FIELDS before it ever
    reaches here — it is interpolated into a prompt as a schema key, and a
    teacher-supplied string must never be.
    """
    rules = planning_rules() if subject == "AP Language & Composition" else ""
    label = FIELD_LABELS.get(field, field)

    codes_note = (
        "This field carries standard codes. Every code you cite must appear in "
        "the retrieved standards block above — do not recall one from memory."
        if field in ("standards", "act_alignment")
        else "Do NOT put a standard code in this field; it does not carry one."
    )

    blocks = [
        f"You are an expert {subject} curriculum designer for Grade {grade}. You are "
        f"revising ONE FIELD — the '{label}' cell — of ONE day of an existing weekly "
        "lesson plan, based on the teacher's feedback.",
        grounding_constraints(subject, grade),
        _custom_instructions_block(custom_instructions),
        f"TEACHER'S PLANNING RULES:\n\n{rules}" if rules else "",
        "SCHOOL PROFILE (Logistics & Exceptions):\n\n" + school_profile(),
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        "THE FULL WEEK, for context only — do NOT rewrite any of it:\n\n" + full_plan_context,
        f"""TASK:

Rewrite ONLY the `{field}` value of the day given, applying the teacher's
feedback. Every other field of that day is being kept exactly as it is and you
must not restate, reference-edit, or attempt to change any of them — your output
is merged over a single key. Keep the new value coherent with the day's other
fields, which you can see. {codes_note}

Return JSON with exactly one key:

{json.dumps(field_json_schema(field), indent=2)}""",
    ]
    return "\n\n---\n\n".join(b for b in blocks if b.strip())
