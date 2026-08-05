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
      "engagement_strategy": ["Think/Pair/Share", "Cold Call"],  # list, rendered bold
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
import re
import shutil
import sys
import zipfile
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.shared import Pt, Twips

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


def shade(cell, hex_fill):
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tcpr.append(shd)


def set_width(cell, dxa):
    """python-docx's own width setter already writes a correct
    <w:tcW w:type="dxa"> -- do NOT also append one by hand. Doing so produced
    a duplicate tcW that fails OOXML schema validation (caught 2026-08-03);
    LibreOffice tolerated it but Word can flag such files as needing repair."""
    cell.width = Twips(dxa)


def fixed_layout(table):
    """Force fixed table layout. w:tblLayout must be inserted in its
    schema-mandated position within w:tblPr (before tblCellMar/tblLook), not
    appended at the end -- appending put it after tblLook and failed
    validation (caught 2026-08-03)."""
    tblpr = table._tbl.tblPr
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tblpr.insert_element_before(
        layout, "w:tblCellMar", "w:tblLook", "w:tblCaption",
        "w:tblDescription", "w:tblPrChange",
    )


def write_plain(cell, text, bold=False, align=WD_ALIGN_PARAGRAPH.LEFT, size=11):
    cell.text = ""
    para = cell.paragraphs[0]
    para.alignment = align
    run = para.add_run(text)
    run.font.size = Pt(size)
    run.font.bold = bold


def write_label(cell, label_text):
    write_plain(cell, label_text, bold=True)


CHIP_FILL = "e8eaed"   # Google Docs' own dropdown-chip grey


def write_dropdown(cell, selected_text, options, control_id):
    """Render a dropdown-list content control (w:sdt/w:dropDownList) that
    Google Drive's docx->Doc conversion turns into a real interactive Google
    Docs dropdown chip.

    IMPORTANT -- read before "fixing" this (settled 2026-08-03):

    This does NOT produce an interactive dropdown chip in Google Docs, and
    nothing can. Google Docs dropdown chips are creatable ONLY through the
    Google Docs UI by a human. Proven exhaustively:

      * .docx import never reconstructs the control. Tested even with markup
        that is a verified structural match to what Google Docs itself
        EXPORTS for a hand-made chip (obtained by exporting such a doc back
        to .docx and diffing). Google's docx handling is one-way: it writes
        this markup for Word compatibility but never reads it back.
      * The Docs API and Apps Script have no method to create them (or even
        read them -- getType() returns UNSUPPORTED). Open Google feature
        request: https://issuetracker.google.com/issues/468277653

    So why keep this markup at all? Two real payoffs:
      1. In actual Microsoft Word, this IS a working dropdown.
      2. The chip grey (CHIP_FILL) DOES survive import, so the cell still
         visually reads like a chip in the Google Doc even though it isn't
         clickable.

    Structure is a deliberate match to Google's own export -- do not add
    <w:tag> or <w:sdtEndPr/> (Google never emits them), and keep w:sdtPr
    child order as alias, id, dropDownList. control_id must be unique per
    control; Google emits large negative int32s, so we mirror that.

    If Google ever ships the feature request above, revisit -- that's the
    only thing that would change this.
    """
    cell.text = ""
    para = cell.paragraphs[0]
    para.alignment = WD_ALIGN_PARAGRAPH.LEFT

    sdt = OxmlElement("w:sdt")

    sdt_pr = OxmlElement("w:sdtPr")
    alias = OxmlElement("w:alias")
    alias.set(qn("w:val"), "Engagement Strategy")
    id_el = OxmlElement("w:id")
    id_el.set(qn("w:val"), str(control_id))
    dropdown = OxmlElement("w:dropDownList")
    dropdown.set(qn("w:lastValue"), selected_text)
    for opt in options:
        item = OxmlElement("w:listItem")
        item.set(qn("w:displayText"), opt)
        item.set(qn("w:value"), opt)
        dropdown.append(item)
    sdt_pr.append(alias)
    sdt_pr.append(id_el)
    sdt_pr.append(dropdown)

    sdt_content = OxmlElement("w:sdtContent")
    run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "000000")
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), CHIP_FILL)
    shd.set(qn("w:val"), "clear")
    rpr.append(color)
    rpr.append(shd)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = selected_text
    run.append(rpr)
    run.append(t)
    sdt_content.append(run)

    sdt.append(sdt_pr)
    sdt.append(sdt_content)

    para._p.append(sdt)


def write_content_lines(cell, lines_with_bold):
    """lines_with_bold: list of (text, bold). Empty text = blank spacer line."""
    cell.text = ""
    first = True
    for text, bold in lines_with_bold:
        para = cell.paragraphs[0] if first else cell.add_paragraph()
        first = False
        run = para.add_run(text)
        run.font.size = Pt(11)
        run.font.bold = bold


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


MINIMAL_STYLES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal">
<w:name w:val="Normal"/>
</w:style>
<w:style w:type="table" w:styleId="TableGrid">
<w:name w:val="Table Grid"/>
<w:basedOn w:val="TableNormal"/>
<w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
</w:tblBorders></w:tblPr>
</w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal">
<w:name w:val="Normal Table"/>
</w:style>
</w:styles>'''

STRIP_PARTS = [
    "word/stylesWithEffects.xml",
    "word/theme/theme1.xml",
    "word/numbering.xml",
    "docProps/thumbnail.jpeg",
    "customXml",
]
STRIP_REL_TYPES = ["stylesWithEffects", "theme", "numbering", "customXml"]
STRIP_CONTENT_TYPE_PARTS = [
    "/word/stylesWithEffects.xml", "/word/theme/theme1.xml",
    "/word/numbering.xml", "/customXml/itemProps1.xml",
]


def strip_bloat(docx_path):
    """Post-process a saved .docx in place: drop python-docx's bundled
    default styles/theme/numbering/thumbnail (unused -- every cell here uses
    direct run formatting, not named styles) and replace styles.xml with a
    minimal version covering only what's actually referenced (Normal,
    TableGrid). Shrinks ~40KB to ~8KB with no visual change -- verified by
    rendering both and comparing 2026-08-03."""
    docx_path = Path(docx_path)
    work_dir = docx_path.parent / (docx_path.stem + "_strip_tmp")
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir()

    with zipfile.ZipFile(docx_path) as z:
        z.extractall(work_dir)

    for part in STRIP_PARTS:
        full = work_dir / part
        if full.is_dir():
            shutil.rmtree(full)
        elif full.is_file():
            full.unlink()
    theme_dir = work_dir / "word" / "theme"
    if theme_dir.is_dir() and not any(theme_dir.iterdir()):
        theme_dir.rmdir()

    (work_dir / "word" / "styles.xml").write_text(MINIMAL_STYLES_XML, encoding="utf-8")

    ct_path = work_dir / "[Content_Types].xml"
    ct = ct_path.read_text(encoding="utf-8")
    for part in STRIP_CONTENT_TYPE_PARTS:
        ct = re.sub(r'<Override PartName="' + re.escape(part) + r'"[^/]*/>', '', ct)
    ct_path.write_text(ct, encoding="utf-8")

    rels_path = work_dir / "word" / "_rels" / "document.xml.rels"
    rels = rels_path.read_text(encoding="utf-8")
    for rel_type in STRIP_REL_TYPES:
        rels = re.sub(r'<Relationship [^>]*Type="[^"]*' + rel_type + r'"[^>]*/>', '', rels)
    rels_path.write_text(rels, encoding="utf-8")

    # The package-level rels also point at docProps/thumbnail.jpeg, which we
    # just deleted. Leaving that dangling is a CRITICAL validation failure --
    # Word can report the whole file as corrupt (caught 2026-08-03; an earlier
    # version of this function only cleaned word/_rels/document.xml.rels).
    root_rels_path = work_dir / "_rels" / ".rels"
    root_rels = root_rels_path.read_text(encoding="utf-8")
    root_rels = re.sub(
        r'<Relationship [^>]*Target="docProps/thumbnail\.jpeg"[^>]*/>', '', root_rels)
    root_rels_path.write_text(root_rels, encoding="utf-8")

    # python-docx's stock template emits <w:zoom w:val="bestFit"/>; the schema
    # wants a percent attribute. Harmless in practice but it keeps validation
    # clean, so normalise it.
    settings_path = work_dir / "word" / "settings.xml"
    if settings_path.is_file():
        settings = settings_path.read_text(encoding="utf-8")
        if "w:percent" not in settings:
            settings = settings.replace(
                '<w:zoom w:val="bestFit"/>', '<w:zoom w:percent="100"/>')
            settings_path.write_text(settings, encoding="utf-8")

    docx_path.unlink()
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in work_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(work_dir))

    shutil.rmtree(work_dir)


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
                strategies = d.get("engagement_strategy", [])
                text = ", ".join(strategies) if isinstance(strategies, list) else str(strategies)
                # Large negative int32s, mirroring what Google Docs itself
                # emits; must be unique per control.
                write_dropdown(cell, text, ENGAGEMENT_OPTIONS,
                               control_id=-1823567252 + i)
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
