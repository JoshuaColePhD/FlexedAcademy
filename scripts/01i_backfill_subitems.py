#!/usr/bin/env python3
"""Backfill sub-standards a state's own CASE feed omits, from the CSP rows
already embedded for that state.

A state's own feed is the better source on every axis except one: some
states' CASE exports stop at the standard level and never publish the
lettered sub-items beneath it. Florida's CPALMS export is typed only
Standard / Cluster / Strand / Grade Level — `ELA.1.F.1.4` is there,
`ELA.1.F.1.4.a` ("Recognize and read with automaticity the grade-level sight
words") is not, though it is a real, citable Florida benchmark.

Measured on Florida: switching to CPALMS alone would have dropped 2,860
records, but 82% of those are things the general course is better off
without — 955 Access Points (the parallel alternate-achievement framework
for students with significant cognitive disabilities), 1,300 items CSP gave
synthetic ids because they carry no code at all (they are clarification
notes, not standards), 74 whitespace-corrupted duplicates of codes CPALMS
has correctly, and 14 filed under the wrong subject entirely. Only the
lettered sub-items are a real loss, so only those come back.

Every backfilled record keeps `source_type: csp_api` and `verbatim_ok:
false` — it did not come from the state, and the corpus should not claim it
did.

Usage:
    python scripts/01i_backfill_subitems.py --state FL
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "data" / "processed"

sys.path.insert(0, str(PROJECT_ROOT))

import psycopg2  # noqa: E402
from psycopg2.extras import RealDictCursor  # noqa: E402

from backend.db import _dsn_with_tls  # noqa: E402

# Florida's alternate-achievement framework, and the same idea elsewhere:
# `.In.` independent, `.Pa.` participatory, `.Su.` supported. A parallel
# course of study for a different student population — not a sub-item of the
# general standard, and it should not surface in a general-education plan.
ACCESS_POINT_RE = re.compile(r"\.(In|Pa|Su)\.")
# A lettered leaf under a standard the state's own feed does carry.
SUBITEM_RE = re.compile(r"^(?P<parent>.+)\.(?P<letter>[a-z])$")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True)
    parser.add_argument("--courses", nargs="*", default=["ELA", "Math", "Science", "Social_Studies"])
    args = parser.parse_args()
    state = args.state.upper()

    conn = psycopg2.connect(_dsn_with_tls(), cursor_factory=RealDictCursor)
    cur = conn.cursor()

    grand_total = 0
    for course in args.courses:
        path = OUT_DIR / f"{state.lower()}_{course.lower()}_csp_chunks.json"
        if not path.exists():
            print(f"{course}: no state-feed file at {path.name}; skipping")
            continue
        state_feed = json.loads(path.read_text())
        have = {c["code"].strip() for c in state_feed}

        cur.execute(
            """select metadata as m from chunks
               where metadata->>'state' = %s and metadata->>'course' = %s
                 and metadata->>'source_type' = 'csp_api'""",
            (state, course),
        )
        candidates = [r["m"] for r in cur.fetchall()]

        added = []
        for meta in candidates:
            code = (meta.get("code") or "").strip()
            if not code or code in have or code.startswith("CSP:"):
                continue
            if ACCESS_POINT_RE.search(code):
                continue
            m = SUBITEM_RE.match(code)
            # Keep it only if it is a lettered child of a standard the
            # state's own feed actually carries. That parent test is what
            # rejects containers, malformed codes and typo'd grade bands
            # without needing a list of them.
            if not m or m.group("parent") not in have:
                continue
            record = dict(meta)
            record["code"] = code
            record["verbatim_ok"] = False
            # `embed_text` is consumed by scripts/02_embed_store.py when it
            # builds the document to embed and is not persisted back into
            # the chunk's metadata, so a record read out of the database
            # never has one. Rebuild it in the same shape every ingester
            # writes, or the gate's embedding contract fails.
            description = record.get("description") or ""
            parent_text = record.get("parent_text")
            record["embed_text"] = f"[{code}] {description}" + (
                f" (Under: {parent_text})" if parent_text else ""
            )
            record["notes"] = list(record.get("notes") or []) + [
                f"Sub-standard not published in {state}'s own CASE feed; retained from the "
                "Common Standards Project so the benchmark stays citable."
            ]
            added.append(record)
            have.add(code)

        if added:
            merged = state_feed + added
            path.write_text(json.dumps(merged, indent=2))
            grand_total += len(added)
            print(f"{course}: {len(state_feed)} from state feed + {len(added)} backfilled = {len(merged)}")
        else:
            print(f"{course}: {len(state_feed)} from state feed, nothing to backfill")

    print(f"\nBackfilled {grand_total} sub-standards for {state}.")
    print(f"Verify with: python scripts/ingest_gate.py --state {state}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
