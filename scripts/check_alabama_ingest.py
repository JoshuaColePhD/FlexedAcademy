"""Alabama entry point for the generalised ingestion quality gate.

The checks themselves moved to check_state_ingest.py when the corpus stopped
being Alabama-only. This stays because it is the name in the runbooks, in
eval/test_alabama_ingest_quality.py, and in the standards-ingestion skill's own
"relevant repository entry points" list — and because a state's gate should be
callable by that state's name.

    python scripts/check_alabama_ingest.py            # same as --state AL
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import state_manifest
from check_state_ingest import check_ingest as _check_ingest
from check_state_ingest import load_json, parse_grades  # noqa: F401 — re-exported

STATE = "AL"


def check_ingest(chunks: list[dict], report: list[dict], **kwargs) -> dict:
    """The Alabama gate, with the contract this entry point has always had.

    `check_bindings` defaults to False here and True in check_state_ingest. That
    is deliberate rather than a convenience: Alabama's course_map is documentation
    and a totality target, NOT wired into retrieval, because changing how its
    bindings resolve would break the guarantee that its retrieval results are
    unchanged. Callers of this name predate course_map entirely and are asking the
    question they always asked — are these chunks well-formed. A real ingest goes
    through ingest_case_state.py, which enforces the bindings.
    """
    kwargs.setdefault("manifest", state_manifest.load(STATE))
    kwargs.setdefault("check_bindings", False)
    return _check_ingest(chunks, report, **kwargs)


def main(argv: list[str] | None = None) -> int:
    from check_state_ingest import main as _main

    return _main(["--state", STATE, *(argv or sys.argv[1:])])


if __name__ == "__main__":
    sys.exit(main())
