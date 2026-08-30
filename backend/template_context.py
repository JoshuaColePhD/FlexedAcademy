"""Shared context about the selected school's lesson-plan template.

The conversational model and the plan-writing model must receive the same
answer to a deceptively basic question: what day axis does this school's
template use? Keeping that answer here prevents one prompt from asking the
teacher to choose a weekly shape while another prompt already knows the form.
"""
from __future__ import annotations

import json
import logging

from . import db
from .schema import DAY_NAMES
from .schoolcal import NO_CALENDAR_SCHOOL_ID

log = logging.getLogger("flexedacademy.template_context")


def _names_from_layout_spec(spec: dict | None) -> list[str] | None:
    if not isinstance(spec, dict):
        return None
    columns = ((spec.get("table") or {}).get("columns") or [])
    day_columns = [c for c in columns if isinstance(c, dict) and c.get("role") == "day"]
    indexes = sorted(c.get("day_index") for c in day_columns if isinstance(c.get("day_index"), int))
    if not indexes or indexes != list(range(len(indexes))) or len(indexes) > len(DAY_NAMES):
        return None
    return DAY_NAMES[: len(indexes)]


def _names_from_structure(structure: dict | None) -> list[str] | None:
    """Read explicit weekday labels from deterministic template extraction."""
    if not isinstance(structure, dict):
        return None
    canonical = {name.casefold(): name for name in DAY_NAMES}
    for table in structure.get("tables") or []:
        if not isinstance(table, dict):
            continue
        rows = [table.get("header_row") or [], *(table.get("sample_rows") or [])]
        for row in rows:
            labels = [str(cell).strip().casefold() for cell in row]
            ordered = [canonical[label] for label in labels if label in canonical]
            if ordered:
                return ordered
    return None


def day_names_for_school(
    school_id: str | None,
    *,
    template_id: str | None = None,
    user_id: str | None = None,
) -> list[str]:
    """Return the selected template's known day columns.

    DB/template reads are best-effort. Missing template analysis must not make
    chat unavailable; the canonical weekday axis remains the safe fallback
    used by the existing builders and validator.
    """
    if not school_id or school_id == NO_CALENDAR_SCHOOL_ID:
        return list(DAY_NAMES)

    selected = template_id
    try:
        if not selected and user_id:
            preferred = db.get_preferred_school_template(user_id, school_id)
            selected = preferred.get("id") if preferred else None
        names = _names_from_layout_spec(db.get_school_builder_spec(school_id, selected))
        if names:
            return names
    except Exception:
        log.debug("could not read builder layout spec for school %s", school_id, exc_info=True)

    try:
        template = db.get_school_template(selected) if selected else db.get_latest_school_template(school_id)
        structure = json.loads(template["structure_json"]) if template and template.get("structure_json") else None
        names = _names_from_structure(structure)
        if names:
            return names
    except Exception:
        log.debug("could not read uploaded template structure for school %s", school_id, exc_info=True)

    return list(DAY_NAMES)


def weekly_template_context(
    school_id: str | None,
    *,
    template_id: str | None = None,
    user_id: str | None = None,
) -> str:
    """Return prompt-ready context for the fixed day axis."""
    names = day_names_for_school(school_id, template_id=template_id, user_id=user_id)
    axis = (
        "complete five-day Monday-Friday structure"
        if names == DAY_NAMES
        else f"fixed {len(names)}-day weekly day axis: {', '.join(names)}"
    )
    return (
        f"The selected school's lesson-plan template defines its {axis}. "
        "This template context is authoritative. "
        "The teacher does not choose a weekly shape or day count. Build the "
        "complete template-defined week; use the school calendar only to mark "
        "individual no-school days."
    )
