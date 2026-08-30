#!/usr/bin/env python3
"""Build a Florence City Schools weekly lesson plan .docx (template florence-docx-v2).

Usage:
    python3 build_lesson_plan.py week.json "Week_11_Oct_19-23.docx"

Input JSON schema (see example-week.json):
{
  "teacher": "Josh Cole",
  "course": "AP Language & Composition",   # optional, shown next to Period(s)
  "week_of": "Week 11 — Oct 19-23, 2026",
  "period": "3rd period",                  # optional
  "days": [                                # exactly 5: Monday..Friday
    {
      "name": "Monday",
      "no_school": false,
      "standards": "2.A",                        # course/content standard code(s)
      "act_alignment": "TOD 502, ORG 403",        # ACT English code(s), see act-english-standards.md
      "learning_targets": "I can ...",            # must start with "I can…"
      "engagement_strategy": "Think/Pair/Share",  # one dropdown selection
      "do_now": "...",                            # bell work, ~5 min
      "during": "...",                            # full instructional narrative, no sub-labels
      "assessment": "..."                         # the evidence/artifact produced
    }, ... ]
}

Reproduces the district's own table/cell structure (one landscape table, this
skill's real filled example had 6 columns: label + one per subject) with the
column axis repurposed to days (label + Monday..Friday), since Josh only
teaches English preps — see `reference/fcs-template-spec.md` (template
florence-docx-v2, replacing the old v1 landscape week-grid as of 2026-08-03).
Header/label-column shading (`6d9eeb`) and column widths mirror the source
file. Requires python-docx (`pip install python-docx`).

After saving, the output is automatically stripped of python-docx's bundled
default styles (styles.xml/stylesWithEffects.xml, theme, numbering, thumbnail
— none of which this template actually references, since every cell uses
direct run formatting, not named styles). This shrinks the file from ~40KB to
~8KB with zero visual difference, confirmed 2026-08-03 by rendering both and
comparing. That makes it cheap enough to upload directly to Drive as a real
.docx and let Drive's own docx->Google-Doc conversion do the work — including
correctly preserving landscape orientation, which the .docx's real OOXML page
setup carries and Drive's converter reads natively. This replaced an earlier,
more complicated approach (uploading HTML instead, which is cheaper but never
carries page setup, needing a whole separate Apps Script fixer) — abandoned
2026-08-03 once this direct approach proved simpler and needs no scripts at
all for whoever runs this later. See Step 5.1 in SKILL.md.
"""

import json
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Twips

# docx_build.builder() loads this file directly by path
# (importlib.util.spec_from_file_location), not as part of the `backend.builder`
# package, so a relative `from .docx_helpers import ...` has no parent package
# to resolve against. Ensure this file's own directory is importable instead —
# harmless if it's already on sys.path (e.g. imported normally by the codegen
# pipeline).
_THIS_DIR = str(Path(__file__).resolve().parent)
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
from docx_helpers import (
    fixed_layout,
    set_width,
    shade,
    strip_bloat,
    write_content_lines,
    write_dropdown,
    write_label,
    write_plain,
)

BLUE = "6d9eeb"   # header rows + label column, matches source template
WHITE = "FFFFFF"

LABEL_W = 1980        # DXA
DAY_W = 2484          # DXA
COL_DXA = [LABEL_W] + [DAY_W] * 5

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]

ENGAGEMENT_OPTIONS = [
    "Cold Call", "Equity Sticks", "Think/Pair/Share", "Small Groups",
    "A/B Partners", "Write 1st, Talk 2nd", "Gallery Walk", "Rally Coach",
]


def build_lesson_cell(cell, day):
    lines = []
    lines.append(("Do Now:", True))
    for ln in (day.get("do_now") or "").strip().split("\n"):
        if ln.strip():
            lines.append((ln.strip(), False))
    lines.append(("", False))
    lines.append(("During:", True))
    for ln in (day.get("during") or "").strip().split("\n"):
        if ln.strip():
            lines.append((ln.strip(), False))
    lines.append(("", False))
    lines.append(("Assessment:", True))
    for ln in (day.get("assessment") or "").strip().split("\n"):
        if ln.strip():
            lines.append((ln.strip(), False))
    write_content_lines(cell, lines)


def build(data, out_path):
    doc = Document()

    # Landscape letter, 0.5" margins — matches the district's own template
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width = Twips(15840)
    sec.page_height = Twips(12240)
    sec.top_margin = sec.bottom_margin = Twips(720)
    sec.left_margin = sec.right_margin = Twips(720)

    days = {d["name"]: d for d in data.get("days", [])}

    table = doc.add_table(rows=0, cols=6)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    fixed_layout(table)

    # Row 0: Teacher | Subject: English | Week (each merged across 2 cols)
    r0 = table.add_row().cells
    for i in range(0, 6, 2):
        set_width(r0[i], COL_DXA[i] if i == 0 else DAY_W)
        r0[i].merge(r0[i + 1])
    write_plain(r0[0], f"Teacher: {data.get('teacher', '')}", bold=True)
    shade(r0[0], BLUE)
    write_plain(r0[2], "Subject: English", bold=True)
    shade(r0[2], BLUE)
    write_plain(r0[4], f"Week: {data.get('week_of', '')}", bold=True)
    shade(r0[4], BLUE)

    # Row 1: Period(s)/course label | Monday..Friday
    r1 = table.add_row().cells
    period_label = f"Period(s): {data.get('period', '')}".rstrip()
    if data.get("course"):
        period_label += f" ({data['course']})"
    set_width(r1[0], COL_DXA[0])
    write_label(r1[0], period_label)
    shade(r1[0], BLUE)
    for i, name in enumerate(DAY_NAMES, start=1):
        set_width(r1[i], COL_DXA[i])
        write_plain(r1[i], name, bold=True)
        shade(r1[i], BLUE)

    # Rows 2-6: label col + per-day content
    ROW_LABELS = [
        ("Learning Targets:", "learning_targets"),
        ("Standards:", "standards"),
        ("ACT Alignment:", "act_alignment"),
        ("Engagement Strategy: (required)", "engagement_strategy"),
        ("Lesson:", None),  # special-cased below
    ]

    for label, key in ROW_LABELS:
        row = table.add_row().cells
        set_width(row[0], COL_DXA[0])
        write_label(row[0], label)
        shade(row[0], BLUE)
        for i, name in enumerate(DAY_NAMES, start=1):
            set_width(row[i], COL_DXA[i])
            d = days.get(name, {"no_school": True})
            cell = row[i]
            if d.get("no_school"):
                if key == "learning_targets":
                    write_plain(cell, "No School", bold=True,
                                align=WD_ALIGN_PARAGRAPH.CENTER)
                else:
                    cell.text = ""
                shade(cell, WHITE)
                continue
            if key is None:  # Lesson row
                build_lesson_cell(cell, d)
            elif key == "engagement_strategy":
                strategy = d.get("engagement_strategy", "")
                # Legacy plans may reach the standalone builder without first
                # passing through schema.normalize_day(). A dropdown has one
                # selected value, so never join an old list into the cell.
                text = str(strategy[0]) if isinstance(strategy, list) and strategy else str(strategy)
                # Large negative int32s, mirroring what Google Docs itself
                # emits; must be unique per control.
                write_dropdown(cell, text, ENGAGEMENT_OPTIONS,
                               control_id=-1823567252 + i,
                               alias="Engagement Strategy")
            else:
                write_plain(cell, str(d.get(key, "")).strip())
            shade(cell, WHITE)

    doc.save(out_path)
    strip_bloat(out_path)
    print(f"Wrote {out_path}")


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 build_lesson_plan.py <week.json> <output.docx>")
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = json.load(fh)
    build(data, sys.argv[2])


if __name__ == "__main__":
    main()
