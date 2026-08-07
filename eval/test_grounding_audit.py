#!/usr/bin/env python3
"""audit_grounding: does layer 3 actually SEE the codes the corpus uses?

Layer 3 is described in retrieval.py as "the only one that's actually verifiable
rather than trusted". It parses codes out of the generated plan with _CODE_RE and
checks them against what retrieval supplied. If that regex cannot recognise a
code, the check silently passes — which is worse than no check, because the plan
carries no warning.

Every case below is a real code shape from the live corpus, or a real failure
observed in a generated plan.

Run:  ./venv/bin/python eval/test_grounding_audit.py   (no DB, no API)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.retrieval import _CODE_RE, _norm_code, audit_grounding  # noqa: E402

# --- 1. the regex sees the corpus's own code vocabulary ---------------------
PARSE_CASES = [
    # (text as it appears in a plan, codes that must be extracted)
    ("LO.3.A.3.1 -- The student is able to analyze a scenario", ["LO.3.A.3.1"]),
    ("R.WME.501", ["R.WME.501"]),
    ("S.IOD.301 and E.CSE.401", ["S.IOD.301", "E.CSE.401"]),
    ("M.IES.301", ["M.IES.301"]),
    ("W.DEV.501", ["W.DEV.501"]),
    ("3.C -- Justify or support a claim", ["3.C"]),
    # AP Lang's own essential-knowledge codes. The trailing letter used to fail
    # the closing lookahead, so RHS-1 matched and RHS-1A did not — and the
    # corpus is mostly the lettered form (RHS-1A..1E, RHS-2A, RHS-2B). A live
    # plan cited RHS-1A, the grounding line reported four codes for a week that
    # cited five, and an invented one could not have been flagged.
    ("RHS-1A -- Identify and describe components of the rhetorical situation", ["RHS-1A"]),
    ("RHS-2B", ["RHS-2B"]),
    ("CLE-4 -- Analyze and select evidence", ["CLE-4"]),
    ("RHS-1", ["RHS-1"]),
    ("ELA21.11.R2", ["ELA21.11.R2"]),
    ("MA19.GDA.5", ["MA19.GDA.5"]),
    ("SC23.PHYS.2c", ["SC23.PHYS.2c"]),
    ("Grade11-21", ["Grade11-21"]),
    ("EK 1.2.A.1", ["EK 1.2.A.1"]),
    ("cites R6.", ["R6"]),
    ("the legacy CLR 501 code", ["CLR 501"]),
    # The regression that started this: a physics learning objective must NOT be
    # read as the AP Lang skill "3.A" hiding inside it.
    ("LO.3.A.3.1", ["LO.3.A.3.1"]),
    ("LO.2.B.5.4", ["LO.2.B.5.4"]),
]

# --- 2. the audit catches the physics case ---------------------------------
# An AP Physics week grounded in AP Physics standards, where the ACT row was
# filled with an ELA standard from another subject. Both cited codes exist in
# the corpus; only one was retrieved for this request.
PHYSICS_PLAN = {
    "days": [
        {"name": "Monday", "standards": "LO.3.A.3.1", "act_alignment": "R.WME.501"},
        {"name": "Tuesday", "standards": "LO.3.A.3.1", "act_alignment": "R6"},
        {"name": "Wednesday", "standards": "LO.3.A.3.1", "act_alignment": "S.EMI.501"},
        {"name": "Thursday", "no_school": True},
        {"name": "Friday", "standards": "LO.9.Z.9.9", "act_alignment": ""},
    ]
}
PHYSICS_ALLOWED = {_norm_code(c) for c in ("LO.3.A.3.1", "S.EMI.501")}

EXPECT_FLAGGED = {"R.WME.501", "R6", "LO.9.Z.9.9"}   # borrowed, borrowed, invented
EXPECT_CLEAN = {"LO.3.A.3.1", "S.EMI.501"}


def main() -> int:
    failures: list[str] = []

    print("--- code parsing ---")
    for text, expected in PARSE_CASES:
        got = _CODE_RE.findall(text)
        ok = got == expected
        print(f"  {'ok ' if ok else 'FAIL'} {text[:46]:48} -> {got}")
        if not ok:
            failures.append(f"parse {text!r}: expected {expected}, got {got}")

    print("\n--- audit on a plan with borrowed + invented codes ---")
    warnings = audit_grounding(PHYSICS_PLAN, PHYSICS_ALLOWED)
    blob = " ".join(warnings)
    for w in warnings:
        print(f"  ! {w}")
    if not warnings:
        print("  (no warnings)")

    for code in EXPECT_FLAGGED:
        if code not in blob:
            failures.append(f"audit did NOT flag {code}")
    for code in EXPECT_CLEAN:
        if code in blob:
            failures.append(f"audit wrongly flagged the grounded code {code}")
    if "3.A" in blob and "LO.3.A.3.1" not in blob:
        failures.append("audit flagged the fragment '3.A' carved out of LO.3.A.3.1")

    print()
    if failures:
        print(f"FAIL — {len(failures)} problem(s):")
        for f in failures:
            print(f"  * {f}")
        return 1
    print("PASS — every corpus code shape is parsed; borrowed and invented codes are flagged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
