"""Proves generic_renderer.render() correctly reproduces Florence's own
template — the verification generic_renderer.py's own module docstring
promises. Renders the same fixture plan two ways:

  1. build_lesson_plan.py's hand-written OOXML calls (the production,
     teacher-facing path for Florence today).
  2. generic_renderer.render() driven by florence_reference_spec.py — the
     shared interpreter every future school's LLM-generated spec also goes
     through.

...then compares the two documents' word/document.xml (not raw file bytes:
python-docx's zip writer stamps each entry with the current time, so two
saves a heartbeat apart differ in zip metadata even with byte-identical
content — the XML payload is what actually encodes structure/content, and
is what's worth being identical).

A real bug this test caught the day it was written: generic_renderer.py's
_render_body_cell_content() read a flat cell_source shape
(`source["field"]`), but BUILDER_LAYOUT_JSON_SCHEMA in schema.py — the
actual contract codegen.py's LLM call and spec_validate.py's validator both
already agreed on — nests it under `source["day_field"]["field"]` /
`source["multi_field_block"]["fields"]`. Every spec that passed validation
would have KeyError'd in render(). Fixed alongside this test; this test is
what would have caught it before `builder_codegen_enabled` ever flipped on
in production.

Run (either form works; both resolve `backend` as an absolute-import
package, the same convention eval/test_grounding_audit.py etc. already use
— generic_renderer.py's own `from ..schema import ...` needs it imported
that way, not as a bare script):

  python3 backend/builder/test_generic_renderer.py
  pytest backend/builder/test_generic_renderer.py

Also runs as part of `python3 eval/run_all.py --fast` (see SUITES there) —
this needs no DB and no API, so it belongs in that no-DB/no-API set.
"""
from __future__ import annotations

import json
import sys
import tempfile
import zipfile
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parents[1]  # backend/builder -> backend -> repo root
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
if str(_THIS_DIR) not in sys.path:
    # build_lesson_plan.py is loaded by path (docx_build.builder()), never as
    # part of the `backend.builder` package — same sys.path shim it uses on
    # itself to reach its own docx_helpers import, needed here too since this
    # test imports it directly for the "before" side of the comparison.
    sys.path.insert(0, str(_THIS_DIR))

import build_lesson_plan

from backend.builder.florence_reference_spec import FLORENCE_REFERENCE_SPEC
from backend.builder.generic_renderer import render as render_spec


def _document_xml(docx_path: Path) -> bytes:
    with zipfile.ZipFile(docx_path) as zf:
        return zf.read("word/document.xml")


def test_generic_renderer_matches_build_lesson_plan():
    fixture = json.loads((_THIS_DIR / "example-week.json").read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory() as tmp:
        original_path = Path(tmp) / "original.docx"
        generic_path = Path(tmp) / "generic.docx"

        build_lesson_plan.build(fixture, str(original_path))
        render_spec(FLORENCE_REFERENCE_SPEC, fixture, str(generic_path))

        original_xml = _document_xml(original_path)
        generic_xml = _document_xml(generic_path)

        assert original_xml == generic_xml, (
            "generic_renderer output diverged from build_lesson_plan.py's own output — "
            "see florence_reference_spec.py, the hand-authored spec meant to reproduce it exactly."
        )


def test_generic_renderer_rejects_day_index_gap():
    """A quick sanity check on the renderer's own defensiveness, independent
    of spec_validate.py (which runs earlier in the real pipeline, before a
    spec like this would ever reach render()) — day columns missing an
    index should fail loudly, not silently render a blank day."""
    from backend.builder.generic_renderer import SpecRenderError

    broken = json.loads(json.dumps(FLORENCE_REFERENCE_SPEC))  # deep copy
    del broken["table"]["columns"][1]["day_index"]

    fixture = json.loads((_THIS_DIR / "example-week.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        raised = False
        try:
            render_spec(broken, fixture, str(Path(tmp) / "broken.docx"))
        except SpecRenderError:
            raised = True
        assert raised, "render() should reject a day column with no day_index"


if __name__ == "__main__":
    test_generic_renderer_matches_build_lesson_plan()
    print("PASS: generic_renderer reproduces build_lesson_plan.py's output byte-for-byte (document.xml)")
    test_generic_renderer_rejects_day_index_gap()
    print("PASS: render() rejects a day column with no day_index")
