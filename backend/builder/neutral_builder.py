"""A school-neutral temporary document for unverified uploaded templates.

It deliberately contains no Florence-only fields, colors, or district naming.
"""
from __future__ import annotations

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Twips

from .docx_helpers import fixed_layout, set_width, shade, strip_bloat, write_content_lines, write_plain

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
COL_DXA = [1900] + [2500] * 5
ROWS = [
    ("Standards", "standards"),
    ("Learning target", "learning_targets"),
    ("Opening", "do_now"),
    ("Learning activities", "during"),
    ("Assessment", "assessment"),
]


def build(data: dict, out_path: str) -> None:
    doc = Document()
    section = doc.sections[0]
    section.orientation = WD_ORIENT.LANDSCAPE
    section.page_width, section.page_height = Twips(15840), Twips(12240)
    section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = Twips(720)
    days = {day["name"]: day for day in data.get("days", [])}
    table = doc.add_table(rows=0, cols=6)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    fixed_layout(table)

    header = table.add_row().cells
    for index, width in enumerate(COL_DXA): set_width(header[index], width)
    header[0].merge(header[5])
    write_plain(header[0], f"Lesson plan — {data.get('week_of', '')}", bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
    shade(header[0], "E5E7EB")

    weekdays = table.add_row().cells
    for index, width in enumerate(COL_DXA):
        set_width(weekdays[index], width)
        write_plain(weekdays[index], "Lesson component" if index == 0 else DAY_NAMES[index - 1], bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
        shade(weekdays[index], "E5E7EB")

    for label, field in ROWS:
        cells = table.add_row().cells
        for index, width in enumerate(COL_DXA): set_width(cells[index], width)
        write_plain(cells[0], label, bold=True)
        shade(cells[0], "F3F4F6")
        for index, name in enumerate(DAY_NAMES, start=1):
            day = days.get(name, {"no_school": True})
            value = day.get("title") or "No school" if day.get("no_school") else str(day.get(field, "") or "")
            if field == "during":
                write_content_lines(cells[index], [(line, False) for line in value.split("\n") if line.strip()] or [("", False)])
            else:
                write_plain(cells[index], value)
    doc.save(out_path)
    strip_bloat(out_path)
