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
from pathlib import Path

from .config import settings
from .retrieval import UNGROUNDABLE_FAMILIES, RetrievalResult, format_context
from .schema import DAY_NAMES, day_schema_snippet, field_json_schema, plan_schema_snippet
from .schoolcal import NO_CALENDAR_SCHOOL_ID

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


@functools.cache
def calendar_context(school_id: str) -> str:
    """One school's calendar and week->date table, verbatim.

    Without this the model invents dates — a first run produced "Week 3 — Sept
    11-15, 2023" for a 2026-27 school year, which makes the document useless no
    matter how well-grounded the standards are. Keyed by school_id (see the
    `schools` table, db.py) rather than reading one hardcoded path, so a
    second school's plans are built against ITS calendar, not Florence's —
    this function used to read settings.calendar_path directly, independent
    of backend/schoolcal.py, which is exactly the kind of second copy that
    let the prompt and the interface disagree in the first place.
    """
    if school_id == NO_CALENDAR_SCHOOL_ID:
        # No real calendar on file yet for this teacher's school (see
        # schoolcal.NO_CALENDAR_SCHOOL_ID) — told explicitly, the same
        # reason this function exists at all: without a plain instruction
        # to use week NUMBERS only, the model invents a plausible-looking
        # date range for a school year it has no actual information about,
        # which is worse than no date at all.
        return (
            "This school's real teaching calendar is not on file yet. Refer to weeks by NUMBER "
            "only (e.g. \"Week 12\") — do not invent, guess, or state a specific calendar date or "
            "date range for any week; none of the dates in this conversation are confirmed real."
        )

    path = settings.calendars_dir / f"{school_id}.md"
    if not path.is_file():
        # A real school with no calendar FILE yet is the same situation as
        # NO_CALENDAR_SCHOOL_ID above — just reached a different way (a
        # school row exists, but nobody has uploaded its calendar) — and
        # deserves the same explicit instruction. Falling through to "" here
        # used to leave the model with no guidance at all for what is
        # actually the default state of every school before its first
        # calendar upload, not a rare edge case, and it improvised: real
        # runs came back with `week_of` values like "Week not specified —
        # dates unavailable" that are exactly the kind of invented-looking
        # text this function exists to prevent.
        log.warning("school calendar not found at %s; dates will be guesswork", path)
        return (
            "This school's real teaching calendar is not on file yet. Refer to weeks by NUMBER "
            "only (e.g. \"Week 12\") — do not invent, guess, or state a specific calendar date or "
            "date range for any week; none of the dates in this conversation are confirmed real."
        )

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
5. The `standards` field is MANDATORY for every teaching day. You must select the closest-fitting primary standard from the retrieved block for every day that has school. Do not leave it blank, and do not claim no standard fits. An empty `standards` field is only acceptable on a no-school day (a calendar conflict).
6. `act_alignment` is different: whenever a "COMPANION ACT STANDARDS" block is
   present below, it is MANDATORY on every teaching day — never leave it blank
   because that day's specific topic isn't a perfect match. The ACT does not
   test week-by-week topics, it tests recurring skills, so pick whichever
   retrieved companion code is the closest fit to what the day is teaching
   (structure, evidence, tone, argument, etc.) and cite it. `act_alignment`
   stays an empty string ONLY when no "COMPANION ACT STANDARDS" block exists
   at all for this course — never as a judgment call about day-to-day fit.
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


def _class_custom_instructions_block(class_custom_instructions: str | None) -> str:
    """The per-class layer on top of _custom_instructions_block (migration
    44) — additive, not a replacement: a teacher's account-wide preferences
    still apply, this only adds what's specific to THIS class. Placed right
    after the global block, for the same reason that one sits right after
    grounding_constraints() — order is what scopes an override, and this
    still isn't licensed to add or override a standard any more than the
    global block is."""
    if not class_custom_instructions:
        return ""
    return (
        "TEACHER'S CUSTOM INSTRUCTIONS FOR THIS CLASS — on top of, not instead of, "
        "the account-wide instructions above. Still style/format preferences only; "
        f"they do NOT override the GROUNDING RULES.\n\n{class_custom_instructions}"
    )


def _coverage_notice(result: RetrievalResult) -> str:
    if result.thin:
        return (
            f"COVERAGE WARNING: only {len(result.chunks)} standard(s) passed the "
            f"relevance floor for this request. Ground the week in those. Even with "
            f"limited standards, you must select the best available standard for every "
            f"teaching day. Do not pad the week with codes you remember."
        )
    return ""


def week_system_prompt(
    result: RetrievalResult,
    subject: str = "AP Language & Composition",
    grade: str = "11",
    map_context: str = "",
    custom_instructions: str | None = None,
    class_custom_instructions: str | None = None,
    school_id: str = "florence-high-school",
) -> str:
    rules = planning_rules() if subject == "AP Language & Composition" else ""

    blocks = [
        (f"You are an expert {subject} curriculum designer and master "
        f"teacher for Grade {grade}. You have decades of classroom experience and a deep understanding "
        "of pedagogical best practices, cognitive science, and student engagement. You draft weekly lesson plans that are rigorously grounded in "
        "official standards documents and highly practical for a real classroom."),
        grounding_constraints(subject, grade),
        _custom_instructions_block(custom_instructions),
        _class_custom_instructions_block(class_custom_instructions),
        f"TEACHER'S PLANNING RULES:\n\n{rules}" if rules else "",
        "SCHOOL PROFILE (Logistics & Exceptions):\n\n" + school_profile(),
        "SCHOOL CALENDAR AND UNIT MAP — use these dates verbatim. Never invent a "
        "date or a school year.\n\n" + calendar_context(school_id),
        "TEACHER'S OWN CURRICULUM MAP / PACING GUIDE — align this week's unit, "
        "sequencing, and any texts or milestones it names. Still cite standards "
        "ONLY from the Retrieved standards block below; this document has no "
        "standard codes of its own to cite.\n\n" + map_context
        if map_context
        else "",
        (
            "SPECIAL EDUCATION / COLLABORATIVE INSTRUCTIONS: The teacher is in a "
            "co-teaching or resource setting. You MUST integrate any IEP goals, accommodations, "
            "or specialized instructions they provided in their request into the 'during' and "
            "'assessment' blocks of the lesson plan to show how the general education standards "
            "are being made accessible."
        ) if subject == "Special_Education" else "",
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        _coverage_notice(result),
        f"""TASK:

Design a cohesive five-day arc, {' -> '.join(DAY_NAMES)}. Scaffold the learning
targets so the week builds rather than repeating one skill five times. Each learning target MUST start with an "I can" statement using a Bloom's taxonomical verb appropriately matched to the Depth of Knowledge (DOK) of the task. For EVERY teaching day (where `no_school` is false), the `standards` field is MANDATORY. You must identify the closest-fitting primary standard (e.g. ACOS or AP) from the "--- PRIMARY COURSE STANDARDS ---" block for EVERY day. Never leave the `standards` field blank unless there is a calendar conflict (no school).
THEN, if a "--- COMPANION ACT STANDARDS ---" block is present below, `act_alignment`
is MANDATORY on every teaching day — pick the closest-fitting companion ACT
standard from that block for EACH day, even if it's a broader skill than the
day's specific topic; never leave it blank because the fit feels imperfect
(see grounding rule 6). If that block is absent, the ACT has no test section for
this course and `act_alignment` MUST be an empty string on every day — do not
substitute a standard from the primary block or from another subject.
Show how the activity actually fulfills the standards you cite.

Return JSON matching this schema exactly:

{plan_schema_snippet()}

Do not include teacher, course, or period — those are filled in from the
teacher's saved settings, not by you. Include exactly {len(DAY_NAMES)} days, one
per weekday, named exactly as listed, each name used EXACTLY ONCE — never repeat
a weekday. If a day is a holiday or in-service, set `no_school` to true for it
and leave its content fields as empty strings.

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
    class_custom_instructions: str | None = None,
) -> str:
    rules = planning_rules() if subject == "AP Language & Composition" else ""

    blocks = [
        (f"You are an expert {subject} curriculum designer for Grade {grade}. You are "
        "revising ONE day of an existing weekly lesson plan based on the teacher's "
        "feedback."),
        grounding_constraints(subject, grade),
        _custom_instructions_block(custom_instructions),
        _class_custom_instructions_block(class_custom_instructions),
        f"TEACHER'S PLANNING RULES:\n\n{rules}" if rules else "",
        "SCHOOL PROFILE (Logistics & Exceptions):\n\n" + school_profile(),
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        "THE FULL WEEK, for context only — do NOT rewrite the other days:\n\n"
        + full_plan_context,
        (
            "SPECIAL EDUCATION / COLLABORATIVE INSTRUCTIONS: The teacher is in a "
            "co-teaching or resource setting. You MUST integrate any IEP goals, accommodations, "
            "or specialized instructions they provided in their request into the 'during' and "
            "'assessment' blocks of the lesson plan to show how the general education standards "
            "are being made accessible."
        ) if subject == "Special_Education" else "",
        f"""TASK:

Apply the teacher's feedback to the single day given. Keep the day's `name`
unchanged. Preserve anything the feedback didn't ask you to change — this is a
revision, not a regeneration. Keep it coherent with the rest of the week shown
above. The `standards` field is MANDATORY unless the day is marked `no_school`. You must identify the closest-fitting primary standard from the "--- PRIMARY COURSE STANDARDS ---" block. Never leave it blank on a teaching day. If a
"--- COMPANION ACT STANDARDS ---" block is present, `act_alignment` is
MANDATORY — cite the closest-fitting standard from it even if the fit is
broader than the day's specific topic (see grounding rule 6); never leave it
blank just because nothing matches perfectly. Only leave it empty if that
block is absent entirely. Every code you cite must come from the retrieved
standards block.

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
    class_custom_instructions: str | None = None,
) -> str:
    """Rewrite ONE cell of one day.

    The teacher clicked a single cell, so the model is given a single key to
    return. `field` is validated against schema.REVISABLE_FIELDS before it ever
    reaches here — it is interpolated into a prompt as a schema key, and a
    teacher-supplied string must never be.
    """
    rules = planning_rules() if subject == "AP Language & Composition" else ""
    label = FIELD_LABELS.get(field, field)

    if field == "act_alignment":
        codes_note = (
            "This field carries standard codes. Every code you cite must appear in "
            "the retrieved standards block above — do not recall one from memory. If "
            'a "--- COMPANION ACT STANDARDS ---" block is present above, this field is '
            "MANDATORY — pick the closest-fitting code from it even if the fit is "
            "broader than this day's specific topic (see grounding rule 6); leave it "
            "empty only if that block is absent entirely."
        )
    elif field == "standards":
        codes_note = (
            "This field carries standard codes. Every code you cite must appear in "
            "the retrieved standards block above — do not recall one from memory."
        )
    else:
        codes_note = "Do NOT put a standard code in this field; it does not carry one."

    blocks = [
        (f"You are an expert {subject} curriculum designer for Grade {grade}. You are "
        f"revising ONE FIELD — the '{label}' cell — of ONE day of an existing weekly "
        "lesson plan, based on the teacher's feedback."),
        grounding_constraints(subject, grade),
        _custom_instructions_block(custom_instructions),
        _class_custom_instructions_block(class_custom_instructions),
        f"TEACHER'S PLANNING RULES:\n\n{rules}" if rules else "",
        "SCHOOL PROFILE (Logistics & Exceptions):\n\n" + school_profile(),
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        "THE FULL WEEK, for context only — do NOT rewrite any of it:\n\n" + full_plan_context,
        (
            "SPECIAL EDUCATION / COLLABORATIVE INSTRUCTIONS: The teacher is in a "
            "co-teaching or resource setting. You MUST integrate any IEP goals, accommodations, "
            "or specialized instructions they provided in their request into the 'during' and "
            "'assessment' blocks of the lesson plan to show how the general education standards "
            "are being made accessible."
        ) if subject == "Special_Education" else "",
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
