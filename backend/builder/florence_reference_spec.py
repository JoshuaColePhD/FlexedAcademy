"""A hand-authored BUILDER_LAYOUT_JSON_SCHEMA spec that reproduces Florence's
own template (florence-docx-v2 — see build_lesson_plan.py) through
generic_renderer.render() instead of that file's own hand-written OOXML
calls.

This is the proof generic_renderer.py's own module docstring promises but
never shipped: "Correctness is proven once, by hand-authoring a spec that
reproduces Florence's own layout... see
backend/builder/test_generic_renderer.py." That file didn't exist until this
one landed alongside it. Kept as its own module (not inlined in the test)
so a future school's spec can be diffed against a known-good one, the same
way a snapshot test compares against a fixture.

Field-for-field derivation from build_lesson_plan.py — see that file for the
original OOXML calls this spec reproduces through the shared interpreter:
  - Row 0: Teacher | Subject | Week, each merged across 2 of 6
    columns, BLUE-shaded, bold.
  - Row 1: "Period(s): {period} ({course})" label + Monday..Friday, BLUE.
  - 5 body rows: Learning Targets / Standards / ACT Alignment (plain text),
    Engagement Strategy (dropdown, ENGAGEMENT_OPTIONS), Lesson (a
    Do Now:/During:/Assessment: multi_field_block).
"""
from __future__ import annotations

BLUE = "6d9eeb"
WHITE = "FFFFFF"
LABEL_W = 1980
DAY_W = 2484

FLORENCE_REFERENCE_SPEC = {
    "page": {
        "orientation": "landscape",
        "width_dxa": 15840,
        "height_dxa": 12240,
        "margin_dxa": 720,
    },
    "table": {
        "columns": [
            {"role": "label", "width_dxa": LABEL_W},
            {"role": "day", "day_index": 0, "width_dxa": DAY_W},
            {"role": "day", "day_index": 1, "width_dxa": DAY_W},
            {"role": "day", "day_index": 2, "width_dxa": DAY_W},
            {"role": "day", "day_index": 3, "width_dxa": DAY_W},
            {"role": "day", "day_index": 4, "width_dxa": DAY_W},
        ],
        "header_rows": [
            {
                "cells": [
                    {"text_template": "Teacher: {teacher}", "bold": True, "align": "left", "col_span": 2, "shade_hex": BLUE},
                    {"text_template": "Subject: {subject}", "bold": True, "align": "left", "col_span": 2, "shade_hex": BLUE},
                    {"text_template": "Week: {week_of}", "bold": True, "align": "left", "col_span": 2, "shade_hex": BLUE},
                ],
            },
            {
                "cells": [
                    {"text_template": "Period(s): {period} ({course})", "bold": True, "align": "left", "shade_hex": BLUE},
                    {"text_template": "Monday", "bold": True, "align": "left", "shade_hex": BLUE},
                    {"text_template": "Tuesday", "bold": True, "align": "left", "shade_hex": BLUE},
                    {"text_template": "Wednesday", "bold": True, "align": "left", "shade_hex": BLUE},
                    {"text_template": "Thursday", "bold": True, "align": "left", "shade_hex": BLUE},
                    {"text_template": "Friday", "bold": True, "align": "left", "shade_hex": BLUE},
                ],
            },
        ],
        "body_rows": [
            {
                "label": "Learning Targets:",
                "shade_label_hex": BLUE,
                "shade_body_hex": WHITE,
                "control_type": "plain",
                "dropdown_options_ref": None,
                "no_school_text": "No School",
                "cell_source": {
                    "kind": "day_field",
                    "day_field": {"field": "learning_targets", "source_section_name": "Learning Targets"},
                    "multi_field_block": {"fields": [], "source_section_name": "Learning Targets"},
                },
            },
            {
                "label": "Standards:",
                "shade_label_hex": BLUE,
                "shade_body_hex": WHITE,
                "control_type": "plain",
                "dropdown_options_ref": None,
                "no_school_text": None,
                "cell_source": {
                    "kind": "day_field",
                    "day_field": {"field": "standards", "source_section_name": "Standards"},
                    "multi_field_block": {"fields": [], "source_section_name": "Standards"},
                },
            },
            {
                "label": "ACT Alignment:",
                "shade_label_hex": BLUE,
                "shade_body_hex": WHITE,
                "control_type": "plain",
                "dropdown_options_ref": None,
                "no_school_text": None,
                "cell_source": {
                    "kind": "day_field",
                    "day_field": {"field": "act_alignment", "source_section_name": "ACT Alignment"},
                    "multi_field_block": {"fields": [], "source_section_name": "ACT Alignment"},
                },
            },
            {
                "label": "Engagement Strategy: (required)",
                "shade_label_hex": BLUE,
                "shade_body_hex": WHITE,
                "control_type": "dropdown",
                "dropdown_options_ref": "ENGAGEMENT_OPTIONS",
                "dropdown_control_base_id": -1823567252,
                "dropdown_alias": "Engagement Strategy",
                "no_school_text": None,
                "cell_source": {
                    "kind": "day_field",
                    "day_field": {"field": "engagement_strategy", "source_section_name": "Engagement Strategy"},
                    "multi_field_block": {"fields": [], "source_section_name": "Engagement Strategy"},
                },
            },
            {
                "label": "Lesson:",
                "shade_label_hex": BLUE,
                "shade_body_hex": WHITE,
                "control_type": "plain",
                "dropdown_options_ref": None,
                "no_school_text": None,
                "cell_source": {
                    "kind": "multi_field_block",
                    "day_field": {"field": "do_now", "source_section_name": "Lesson"},
                    "multi_field_block": {
                        "fields": [
                            {"label": "Do Now:", "field": "do_now"},
                            {"label": "During:", "field": "during"},
                            {"label": "Assessment:", "field": "assessment"},
                        ],
                        "source_section_name": "Lesson",
                    },
                },
            },
        ],
    },
    "post_process": {"strip_bloat": True},
}
