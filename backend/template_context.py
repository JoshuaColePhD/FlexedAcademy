"""Shared context about the selected school's lesson-plan template.

The conversational model and the plan-writing model must receive the same
answer to a deceptively basic question: what day axis does this school's
template use? Keeping that answer here prevents one prompt from asking the
teacher to choose a weekly shape while another prompt already knows the form.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from . import db
from .config import settings
from .schema import DAY_CONTENT_FIELDS, DAY_NAMES
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


def template_fields_for_school(
    school_id: str | None,
    *,
    template_id: str | None = None,
    user_id: str | None = None,
) -> set[str]:
    """Return the day-content fields the selected document actually renders.

    ``act_alignment`` is intentionally template-scoped.  The old generation
    path treated it as a universal field because Florence's v2 form has an ACT
    row; that leaked ACT content into templates such as Weeden's, which have no
    such row.  A verified generated layout spec is the strongest source of
    truth.  The two hand-authored builders get the same answer from their
    known contract, and an unknown legacy builder fails closed for ACT rather
    than adding an unrequested row to a document.
    """
    all_fields = set(DAY_CONTENT_FIELDS)
    if not school_id:
        # Legacy/class-less callers still use the canonical Florence contract.
        return all_fields

    try:
        spec = db.get_school_builder_spec(school_id, template_id)
    except Exception:  # noqa: BLE001 — optional metadata must not block planning
        spec = None
    if isinstance(spec, dict):
        mapped: set[str] = set()
        for row in ((spec.get("table") or {}).get("body_rows") or []):
            source = row.get("cell_source") or {}
            if source.get("kind") == "day_field":
                field = (source.get("day_field") or {}).get("field")
                if field:
                    mapped.add(field)
            elif source.get("kind") == "multi_field_block":
                for block in ((source.get("multi_field_block") or {}).get("fields") or []):
                    field = block.get("field")
                    if field:
                        mapped.add(field)
        return mapped

    if school_id == "weeden-elementary-school":
        return all_fields - {"act_alignment"}
    if school_id == settings.default_builder_school_id:
        return all_fields

    # A hand-authored non-default builder predates generated layout specs.
    # Inspect only its local source declaration; never assume a Florence ACT
    # row for another school's format.
    builder_path = Path(settings.builder_path).parent / f"{school_id}_builder.py"
    try:
        source = builder_path.read_text(encoding="utf-8")
    except OSError:
        return all_fields - {"act_alignment"}
    return all_fields if "act_alignment" in source else all_fields - {"act_alignment"}


def has_template_field(
    school_id: str | None,
    field: str,
    *,
    template_id: str | None = None,
    user_id: str | None = None,
) -> bool:
    return field in template_fields_for_school(
        school_id, template_id=template_id, user_id=user_id
    )
