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
import logging
from pathlib import Path

from .config import settings
from .retrieval import UNGROUNDABLE_FAMILIES, RetrievalResult, format_context
from .schema import DAY_NAMES, day_schema_snippet, plan_schema_snippet

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
def known_gaps() -> str:
    path = Path(settings.known_gaps_path)
    return path.read_text(encoding="utf-8") if path.is_file() else ""


@functools.lru_cache(maxsize=1)
def grounding_constraints() -> str:
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
2. The {families} ACT code families are NOT present in any source document we
   hold — our ACT source covers English/Writing only, not Reading. Never cite a
   {families} code, even if a curriculum document elsewhere references one.
3. AP Lang skill codes are scoped to Units 1-7 only. Units 8-9 have no codes in
   our sources. If the request concerns Unit 8 or 9, say so plainly in the
   `standards` field rather than substituting an adjacent code.
4. If no retrieved standard fits a given day, write exactly:
   "No grounded standard retrieved for this day."
   and leave `act_alignment` an empty string. An honest gap is correct output;
   an invented code is not.
"""
    return hard_rules.strip() + "\n\nFor reference, the recorded gaps:\n\n" + known_gaps()


def _coverage_notice(result: RetrievalResult) -> str:
    if result.thin:
        return (
            f"COVERAGE WARNING: only {len(result.chunks)} standard(s) passed the "
            f"relevance floor for this request. Ground the week in those. For any "
            f"day without a fitting standard, use the exact wording from grounding "
            f"rule 4. Do not pad the week with codes you remember."
        )
    return ""


def week_system_prompt(result: RetrievalResult) -> str:
    blocks = [
        "You are an expert AP Language & Composition curriculum designer and master "
        "teacher. You draft weekly lesson plans that are rigorously grounded in "
        "official standards documents.",
        grounding_constraints(),
        "TEACHER'S PLANNING RULES:\n\n" + planning_rules(),
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        _coverage_notice(result),
        f"""TASK:

Design a cohesive five-day arc, {' -> '.join(DAY_NAMES)}. Scaffold the learning
targets so the week builds rather than repeating one skill five times. For each
day, show how the activity actually fulfils the standard you cite.

Return JSON matching this schema exactly:

{plan_schema_snippet()}

Do not include teacher, course, or period — those are filled in from the
teacher's saved settings, not by you. Include exactly {len(DAY_NAMES)} days, one
per weekday, named exactly as listed. If a day is a holiday or in-service, set
`no_school` to true for it and leave its content fields as empty strings.""",
    ]
    return "\n\n---\n\n".join(b for b in blocks if b.strip())


def day_system_prompt(result: RetrievalResult, full_plan_context: str) -> str:
    blocks = [
        "You are an expert AP Language & Composition curriculum designer. You are "
        "revising ONE day of an existing weekly lesson plan based on the teacher's "
        "feedback.",
        grounding_constraints(),
        "TEACHER'S PLANNING RULES:\n\n" + planning_rules(),
        "RETRIEVED STANDARDS (the only standards you may cite):\n\n"
        + (format_context(result) or "(none)"),
        "THE FULL WEEK, for context only — do NOT rewrite the other days:\n\n"
        + full_plan_context,
        f"""TASK:

Apply the teacher's feedback to the single day given. Keep the day's `name`
unchanged. Preserve anything the feedback didn't ask you to change — this is a
revision, not a regeneration. Keep it coherent with the rest of the week shown
above.

Return JSON for that one day matching this schema exactly:

{day_schema_snippet()}""",
    ]
    return "\n\n---\n\n".join(b for b in blocks if b.strip())
