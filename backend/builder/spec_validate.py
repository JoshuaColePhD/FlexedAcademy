"""Deterministic, no-LLM check that a generated BUILDER_LAYOUT_JSON_SCHEMA
spec is actually grounded in the template analysis it was given — the same
"cheap deterministic check before expensive LLM/render cost" ordering
template_intake.py already uses (its stage 3 rule-based checks gate before
stage 4's LLM call). Run this before spending a render + two vision-judge
calls on an attempt; a spec that fails here is rejected without ever touching
generic_renderer or the codegen loop's attempt budget in a meaningful way.

Mirrors how template_intake._cross_validate_llm_output checks that every
`source_evidence` is a real substring of the extraction — this checks the
one layer up: that every `source_section_name` a spec cell claims is a real
section from the given (already-verified) analysis.
"""
from __future__ import annotations

from ..schema import DAY_CONTENT_FIELDS, DAY_NAMES


class SpecValidationError(Exception):
    """One or more findings below made this spec unsafe to render/verify."""

    def __init__(self, findings: list[str]):
        self.findings = findings
        super().__init__("; ".join(findings))


def _cell_source_findings(row_label: str, cell_source: dict, section_names: set[str]) -> list[str]:
    findings: list[str] = []
    kind = cell_source.get("kind")
    if kind == "day_field":
        block = cell_source.get("day_field") or {}
        name = block.get("source_section_name")
        if name not in section_names:
            findings.append(
                f"row {row_label!r}: day_field cell_source names section {name!r}, "
                "which is not one of the template's verified sections"
            )
    elif kind == "multi_field_block":
        block = cell_source.get("multi_field_block") or {}
        name = block.get("source_section_name")
        if name not in section_names:
            findings.append(
                f"row {row_label!r}: multi_field_block cell_source names section {name!r}, "
                "which is not one of the template's verified sections"
            )
        fields = block.get("fields") or []
        if not fields:
            findings.append(f"row {row_label!r}: multi_field_block has no fields")
    else:
        findings.append(f"row {row_label!r}: cell_source.kind is {kind!r}, expected day_field or multi_field_block")
    return findings


def validate_spec_against_analysis(spec: dict, analysis: dict) -> list[str]:
    """Returns a list of finding strings — empty means the spec passed every
    deterministic check. Never raises for a malformed spec (missing keys read
    with .get()); a structurally broken spec just accumulates findings like
    any other problem, so the caller always gets a full list, not a partial
    one cut short by the first KeyError."""
    findings: list[str] = []
    section_names = {s.get("name") for s in analysis.get("sections", [])}

    table = spec.get("table") or {}
    columns = table.get("columns") or []
    day_columns = [c for c in columns if c.get("role") == "day"]

    if len(columns) < 2:
        findings.append("table.columns has fewer than 2 columns")
    if not day_columns:
        findings.append("table.columns has no role='day' columns")

    seen_day_indices = [c.get("day_index") for c in day_columns]
    if sorted(i for i in seen_day_indices if isinstance(i, int)) != list(range(len(DAY_NAMES))):
        findings.append(
            f"day columns must cover day_index 0..{len(DAY_NAMES) - 1} exactly once each; got {seen_day_indices!r}"
        )

    body_rows = table.get("body_rows") or []
    if not body_rows:
        findings.append("table.body_rows is empty — nothing would render per-day content")

    mapped_fields: set[str] = set()
    for row in body_rows:
        label = row.get("label", "<unlabeled row>")
        cell_source = row.get("cell_source") or {}
        findings.extend(_cell_source_findings(label, cell_source, section_names))

        kind = cell_source.get("kind")
        if kind == "day_field":
            f = (cell_source.get("day_field") or {}).get("field")
            if f:
                mapped_fields.add(f)
        elif kind == "multi_field_block":
            for block_field in (cell_source.get("multi_field_block") or {}).get("fields") or []:
                f = block_field.get("field")
                if f:
                    mapped_fields.add(f)

        if row.get("control_type") == "dropdown" and not row.get("dropdown_options_ref"):
            findings.append(f"row {label!r}: control_type is 'dropdown' but dropdown_options_ref is not set")

    missing_fields = set(DAY_CONTENT_FIELDS) - mapped_fields
    if missing_fields:
        findings.append(
            f"the following day-content fields are never mapped to a cell: {sorted(missing_fields)}"
        )

    for header_row in table.get("header_rows") or []:
        span_total = sum(c.get("col_span", 1) for c in header_row.get("cells") or [])
        if span_total != len(columns):
            findings.append(
                f"a header row's cells span {span_total} columns total, but the table has {len(columns)}"
            )

    return findings
