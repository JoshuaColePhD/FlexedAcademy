"""Alabama's framework roster — now sourced from the manifest.

Kept as a name other modules already import. The executable roster lives in
scripts/state_manifests/al.yaml so that one file describes the whole state:
CASE ids, the PDFs that verify them, provenance, and the course_map. Two copies
of "which frameworks exist" is exactly how a framework comes to exist in the
ingest but not in the gate.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import state_manifest

STATE = "AL"

_MANIFEST = state_manifest.load(STATE)

# (course, CASE package id, PDF path relative to the shared standards folder)
FRAMEWORKS = tuple(
    (s.course, s.case_id, s.pdf) for s in _MANIFEST.sources
)

FRAMEWORK_IDS = _MANIFEST.framework_ids
