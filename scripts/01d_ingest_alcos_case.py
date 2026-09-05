#!/usr/bin/env python3
"""Step 1d — Ingest every Alabama Course of Study subject into the chunk schema.

Alabama's entry point over the generic adapter. The parsing itself moved to
scripts/case_adapter.py and the driver to scripts/ingest_case_state.py when the
corpus stopped being Alabama-only; the roster, the CASE server and the PDF
directory moved to scripts/state_manifests/al.yaml.

Nothing about Alabama's output changed. `ingest_case_state.py --state AL
--grades 0-12 --dry-run` reproduces data/raw/ALCOS_INGEST_REPORT.json exactly —
all 19,701 chunks and all 11 frameworks' verbatim counts — which is the gate
that refactor had to pass before Georgia was allowed to start.

Why this still does NOT run the PDFs through an LLM: see case_adapter.py's
module docstring. The standard text comes from ALSDE's own CASE 1.0 feed and the
published PDF is the verification target, not the input.

    python scripts/01d_ingest_alcos_case.py --grades 0-12
    python scripts/01d_ingest_alcos_case.py --only ELA Math
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_case_state import main as _main

STATE = "AL"


def main(argv: list[str] | None = None) -> int:
    return _main(["--state", STATE, *(argv if argv is not None else sys.argv[1:])])


if __name__ == "__main__":
    sys.exit(main())
