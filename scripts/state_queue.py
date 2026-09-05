#!/usr/bin/env python3
"""Work through the states in alphabetical order, resumably.

Ingesting fifty states is a long queue with a lot of gaps in it, and the thing
that goes wrong is losing track of which ones are actually DONE versus which
ones merely have a file. So "done" here is not "a manifest exists" — it is the
manifest having sources AND a course_map, because a state nobody has bound to a
course is a state no teacher can retrieve.

    python scripts/state_queue.py status      # the whole queue, with reasons
    python scripts/state_queue.py next        # just the next state code
    python scripts/state_queue.py scaffold    # write the next state's manifest

Alphabetical by state NAME, which is what people mean by "alphabetically" and
is NOT the same as by postal code: Arizona precedes Arkansas by name, and
Arkansas precedes Arizona by code. Alaska is second either way.

The queue does not fetch or ingest anything. It says what is next and prepares
the file; scripts/fetch_state_sources.py and scripts/ingest_case_state.py do
the work, in that order, and a person authors the course_map in between.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import state_manifest  # noqa: E402

# Mirrors US_STATES in frontend/src/lib/states.js, which is the list a teacher
# actually picks from. Kept in name order because that is the queue order.
US_STATES: tuple[tuple[str, str], ...] = (
    ("AL", "Alabama"), ("AK", "Alaska"), ("AZ", "Arizona"), ("AR", "Arkansas"),
    ("CA", "California"), ("CO", "Colorado"), ("CT", "Connecticut"),
    ("DE", "Delaware"), ("FL", "Florida"), ("GA", "Georgia"), ("HI", "Hawaii"),
    ("ID", "Idaho"), ("IL", "Illinois"), ("IN", "Indiana"), ("IA", "Iowa"),
    ("KS", "Kansas"), ("KY", "Kentucky"), ("LA", "Louisiana"), ("ME", "Maine"),
    ("MD", "Maryland"), ("MA", "Massachusetts"), ("MI", "Michigan"),
    ("MN", "Minnesota"), ("MS", "Mississippi"), ("MO", "Missouri"),
    ("MT", "Montana"), ("NE", "Nebraska"), ("NV", "Nevada"),
    ("NH", "New Hampshire"), ("NJ", "New Jersey"), ("NM", "New Mexico"),
    ("NY", "New York"), ("NC", "North Carolina"), ("ND", "North Dakota"),
    ("OH", "Ohio"), ("OK", "Oklahoma"), ("OR", "Oregon"),
    ("PA", "Pennsylvania"), ("RI", "Rhode Island"), ("SC", "South Carolina"),
    ("SD", "South Dakota"), ("TN", "Tennessee"), ("TX", "Texas"),
    ("UT", "Utah"), ("VT", "Vermont"), ("VA", "Virginia"),
    ("WA", "Washington"), ("WV", "West Virginia"), ("WI", "Wisconsin"),
    ("WY", "Wyoming"),
)

assert [name for _code, name in US_STATES] == sorted(name for _c, name in US_STATES), (
    "US_STATES must stay in name order — it IS the queue"
)

DONE = "done"
NEEDS_COURSE_MAP = "needs course_map"
NEEDS_SOURCES = "needs fetch"
NOT_STARTED = "not started"


def state_status(code: str) -> tuple[str, str]:
    """(status, detail) for one state, read from its manifest."""
    if not state_manifest.manifest_path(code).is_file():
        return NOT_STARTED, "no manifest"
    try:
        manifest = state_manifest.load(code)
    except state_manifest.ManifestError as exc:
        return NOT_STARTED, f"manifest is invalid: {exc}"

    if not manifest.sources:
        return NEEDS_SOURCES, f"run fetch_state_sources.py --state {code}"
    todo = [s.source_id for s in manifest.sources if s.course == "TODO"]
    if todo:
        return NEEDS_COURSE_MAP, f"{len(todo)} framework(s) still `course: TODO`"
    if not manifest.course_map:
        return NEEDS_COURSE_MAP, "sources fetched, nothing bound to a class yet"
    return DONE, f"{len(manifest.sources)} framework(s), {len(manifest.course_map)} binding(s)"


def queue() -> list[tuple[str, str, str, str]]:
    return [(code, name, *state_status(code)) for code, name in US_STATES]


def next_state() -> tuple[str, str, str, str] | None:
    for row in queue():
        if row[2] != DONE:
            return row
    return None


SCAFFOLD = '''# {name} — state standards ingestion manifest.
#
# SCAFFOLD, written by scripts/state_queue.py. Not ingestable until `sources`
# and `course_map` are filled in, and they are filled in by different things:
#
#   * `sources` comes from scripts/fetch_state_sources.py --state {code}, which
#     records package ids, official source URLs and SHA-256 hashes. Machine
#     -written provenance; do not type it by hand.
#   * `course_map` is authored by a person reading {name}'s published course
#     list against the frameworks that fetch actually returned. It is the
#     reviewable artifact of adding a state, and the reason a state cannot be
#     added by running a script alone.
#
# A (subject, grade) that cannot be bound with confidence goes in `unmapped`
# with a reason. A teacher who selects it is told there are no standards yet,
# never handed the nearest-looking framework.

state: {name}
state_code: {code}
ingestion_contract_version: 1

# TO BE CONFIRMED before fetching. If {name} runs its own CASE server, use it:
# the state's own feed is the authoritative publication, and its packages carry
# an officialSourceURL pointing at the PDF that verifies them. Only fall back to
# a mirror when the state publishes no CASE feed of its own — and record which
# was used, because it changes what "verbatim" can be checked against.
authority: TODO — the {name} department of education
case_api: TODO

# TO BE RECORDED from the publisher's actual terms. Left explicitly unknown
# rather than assumed permissive.
license_or_usage: UNKNOWN — record the publisher's published terms before ingesting.

default_grades: "0-12"

pdf_dir: data/raw/source_docs/{code}
output: data/processed/{lower}_chunks.json

sources: []
course_map: []
unmapped: []
'''


def cmd_status() -> int:
    rows = queue()
    width = max(len(name) for _c, name, _s, _d in rows)
    counts: dict[str, int] = {}
    for code, name, status, detail in rows:
        counts[status] = counts.get(status, 0) + 1
        mark = {DONE: "[x]", NEEDS_COURSE_MAP: "[~]", NEEDS_SOURCES: "[>]"}.get(status, "[ ]")
        print(f" {mark} {code}  {name:<{width}}  {status:<15} {detail}")
    print()
    print("  ".join(f"{status}: {n}" for status, n in sorted(counts.items())))
    nxt = next_state()
    if nxt:
        print(f"\nNext: {nxt[1]} ({nxt[0]}) — {nxt[3]}")
    else:
        print("\nEvery state is done.")
    return 0


def cmd_next() -> int:
    nxt = next_state()
    if not nxt:
        print("Every state is done.", file=sys.stderr)
        return 1
    print(nxt[0])
    return 0


def cmd_scaffold() -> int:
    nxt = next_state()
    if not nxt:
        print("Every state is done.", file=sys.stderr)
        return 1
    code, name, status, detail = nxt
    path = state_manifest.manifest_path(code)
    if path.is_file():
        # The next state already has a file; it is blocked on content, not on
        # existing. Overwriting it would discard an authored course_map.
        print(f"{name} ({code}) already has {path.name} — {status}: {detail}")
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(SCAFFOLD.format(name=name, code=code, lower=code.lower()))
    print(f"Wrote {path.relative_to(Path(__file__).resolve().parent.parent)} for {name}.")
    print(f"Next: confirm {name}'s CASE server, fill in `authority` and `case_api`,")
    print(f"      then run scripts/fetch_state_sources.py --state {code}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=("status", "next", "scaffold"), nargs="?",
                    default="status")
    args = ap.parse_args(argv)
    return {"status": cmd_status, "next": cmd_next, "scaffold": cmd_scaffold}[args.command]()


if __name__ == "__main__":
    sys.exit(main())
