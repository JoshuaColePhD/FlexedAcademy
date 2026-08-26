"""The one interpreter for every generated ({school_id}) builder spec.

Every school onboarded through the automated builder-codegen pipeline
(backend/builder_gen.py — not yet built) shares this single, hand-written,
tested renderer instead of getting its own generated Python script. The LLM's
job is narrowed to filling in a closed, enum-constrained JSON spec (see
BUILDER_LAYOUT_JSON_SCHEMA in backend/schema.py); this module is the only
place that ever touches python-docx/OOXML to turn that spec into a real
document. A bug found and fixed here is fixed for every school at once,
unlike a world where each school has its own hand- or LLM-written script that
can independently regress.

Correctness is proven once, by hand-authoring a spec that reproduces
Florence's own layout (see backend/builder/florence_reference_spec.py) and
diffing its rendered output against build_lesson_plan.py's real,
production-verified output — see backend/builder/test_generic_renderer.py.
"""
from __future__ import annotations

from typing import Any

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Twips

from ..schema import DAY_NAMES, ENGAGEMENT_OPTIONS
from .docx_helpers import (
    fixed_layout,
    set_width,
    shade,
    strip_bloat,
    write_content_lines,
    write_dropdown,
    write_label,
    write_plain,
)

# The only named option lists a generated spec is allowed to reference by
# name — deliberately not "any list the LLM writes out", so a dropdown's
# choices stay tied to the one place the app's own generation prompt also
# gets them from (schema.ENGAGEMENT_OPTIONS), instead of drifting.
_DROPDOWN_OPTION_SETS = {
    "ENGAGEMENT_OPTIONS": ENGAGEMENT_OPTIONS,
}

_ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
}


class SpecRenderError(Exception):
    """Raised for a structurally-invalid spec or a plan missing a field the
    spec references — always caught by the codegen loop and turned into a
    finding, never allowed to surface as a raw traceback to a teacher."""


def _identity_context(plan: dict) -> dict:
    return {
        "teacher": str(plan.get("teacher", "") or ""),
        "course": str(plan.get("course", "") or ""),
        "period": str(plan.get("period", "") or ""),
        "week_of": str(plan.get("week_of", "") or ""),
    }


def _render_header_cell(cell, cell_spec: dict, identity: dict) -> None:
    template = cell_spec.get("text_template", "")
    try:
        text = template.format(**identity)
    except (KeyError, IndexError) as e:
        raise SpecRenderError(f"header text_template {template!r} references an unknown field: {e}") from e
    write_plain(
        cell, text,
        bold=bool(cell_spec.get("bold", True)),
        align=_ALIGN.get(cell_spec.get("align", "left"), WD_ALIGN_PARAGRAPH.LEFT),
    )
    if cell_spec.get("shade_hex"):
        shade(cell, cell_spec["shade_hex"])


def _day_value(day: dict, field: str) -> Any:
    return day.get(field)


def _render_body_cell_content(cell, row_spec: dict, day: dict, day_index: int, dropdown_options: list[str] | None) -> None:
    source = row_spec["cell_source"]
    kind = source["kind"]

    if kind == "day_field":
        field = source["field"]
        value = _day_value(day, field)
        if row_spec.get("control_type") == "dropdown":
            options = dropdown_options or []
            text = ", ".join(value) if isinstance(value, list) else str(value or "")
            write_dropdown(
                cell, text, options,
                control_id=row_spec.get("dropdown_control_base_id", -1823567252) + day_index,
                alias=row_spec.get("dropdown_alias", "Dropdown"),
            )
        else:
            write_plain(cell, str(value or "").strip())

    elif kind == "multi_field_block":
        lines: list[tuple[str, bool]] = []
        for i, block in enumerate(source["fields"]):
            if i > 0:
                lines.append(("", False))
            lines.append((block["label"], True))
            text = str(_day_value(day, block["field"]) or "").strip()
            for ln in text.split("\n"):
                if ln.strip():
                    lines.append((ln.strip(), False))
        write_content_lines(cell, lines)

    else:
        raise SpecRenderError(f"unknown cell_source.kind: {kind!r}")


def render(layout_spec: dict, plan: dict, out_path: str) -> None:
    """Render `plan` (the same shape backend/schema.py's plan validator
    already accepts — week_of + days, each with DAY_CONTENT_FIELDS) through
    `layout_spec` into a .docx at out_path. Raises SpecRenderError for any
    structural problem in the spec itself, so the codegen loop can turn a
    bad spec into a finding rather than a bare traceback."""
    page = layout_spec.get("page", {})
    table_spec = layout_spec["table"]
    columns = table_spec["columns"]
    n_cols = len(columns)
    if n_cols < 2:
        raise SpecRenderError("layout_spec.table.columns must have at least 2 columns")

    day_columns = [c for c in columns if c.get("role") == "day"]
    if not day_columns:
        raise SpecRenderError("layout_spec.table.columns must include at least one role='day' column")

    doc = Document()
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.LANDSCAPE if page.get("orientation", "landscape") == "landscape" else WD_ORIENT.PORTRAIT
    if page.get("width_dxa"):
        sec.page_width = Twips(page["width_dxa"])
    if page.get("height_dxa"):
        sec.page_height = Twips(page["height_dxa"])
    margin = page.get("margin_dxa", 720)
    sec.top_margin = sec.bottom_margin = Twips(margin)
    sec.left_margin = sec.right_margin = Twips(margin)

    days_by_name = {d["name"]: d for d in plan.get("days", [])}
    identity = _identity_context(plan)

    table = doc.add_table(rows=0, cols=n_cols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    fixed_layout(table)

    # Header rows: static/identity content, may merge columns via col_span.
    for header_row in table_spec.get("header_rows", []):
        cells = table.add_row().cells
        col_i = 0
        for cell_spec in header_row["cells"]:
            span = cell_spec.get("col_span", 1)
            if col_i + span > n_cols:
                raise SpecRenderError("header row cell col_span overruns the table width")
            target = cells[col_i]
            set_width(target, columns[col_i].get("width_dxa", 1000))
            if span > 1:
                for j in range(1, span):
                    target.merge(cells[col_i + j])
            _render_header_cell(target, cell_spec, identity)
            col_i += span

    # Body rows: one label cell + one cell per day column, mapped through
    # cell_source. Every field referenced here must already be a validated
    # member of schema.DAY_CONTENT_FIELDS — that's enforced upstream by
    # validate_spec_against_analysis, not re-checked here, so an unmapped
    # field surfaces as a KeyError/empty value rather than being silently
    # invented by this renderer.
    for row_spec in table_spec.get("body_rows", []):
        cells = table.add_row().cells
        for col_i, col in enumerate(columns):
            set_width(cells[col_i], col.get("width_dxa", 1000))
            if col.get("role") == "label":
                write_label(cells[col_i], row_spec.get("label", ""))
                if row_spec.get("shade_label_hex"):
                    shade(cells[col_i], row_spec["shade_label_hex"])
                continue

            day_index = col.get("day_index")
            if day_index is None or not (0 <= day_index < len(DAY_NAMES)):
                raise SpecRenderError(f"day column has invalid day_index: {day_index!r}")
            day_name = DAY_NAMES[day_index]
            day = days_by_name.get(day_name, {"no_school": True})
            cell = cells[col_i]

            if day.get("no_school"):
                no_school_text = row_spec.get("no_school_text")
                if no_school_text:
                    write_plain(cell, no_school_text, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
                else:
                    cell.text = ""
            else:
                options_ref = row_spec.get("dropdown_options_ref")
                if options_ref and options_ref not in _DROPDOWN_OPTION_SETS:
                    raise SpecRenderError(f"unknown dropdown_options_ref: {options_ref!r}")
                dropdown_options = _DROPDOWN_OPTION_SETS.get(options_ref) if options_ref else None
                _render_body_cell_content(cell, row_spec, day, day_index + 1, dropdown_options)

            if row_spec.get("shade_body_hex"):
                shade(cell, row_spec["shade_body_hex"])

    doc.save(out_path)
    if layout_spec.get("post_process", {}).get("strip_bloat", True):
        strip_bloat(out_path)
