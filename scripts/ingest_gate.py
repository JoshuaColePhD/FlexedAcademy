#!/usr/bin/env python3
"""Quality gate for a CSP-sourced state ingest (scripts/01e_fetch_csp_state.py),
driven by public.standards_frameworks (scripts/manifest_db.py) instead of a
hardcoded config the way scripts/check_alabama_ingest.py is for Alabama.

CSP-sourced chunks carry weaker provenance than Alabama's own CASE+PDF
cross-checked ones (no sha256 fingerprints, no independent PDF to diff
against), so this gate checks a different, appropriate-to-the-source set of
things: structural validity, a version-string sanity check against the
manifest's independently-researched `adopted_title`, internal near-duplicate
detection, and regression against the last run that actually passed.

A passing gate moves a manifest row from 'staged' to 'stale' (version
mismatch — needs a human to source that course directly) or leaves it ready
for a human to flip to 'active' themselves; this script never activates a
row on its own.

Usage:
    python scripts/ingest_gate.py --state GA
    python scripts/ingest_gate.py --state GA --only ELA Math
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import manifest_db  # noqa: E402

CHUNKS_DIR = PROJECT_ROOT / "data" / "processed"
REPORTS_DIR = PROJECT_ROOT / "data" / "raw" / "audits"

REQUIRED_FIELDS = ("code", "description", "course", "grade", "state", "source_type", "source_document", "embed_text")


def norm_text(s: str) -> str:
    """Same normalization as this session's diff_report.py: strip our own
    italic-markdown, collapse whitespace, normalize smart quotes — so a
    formatting difference doesn't masquerade as two different standards."""
    s = (s or "").strip().lower()
    s = re.sub(r"[*_]", "", s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[‘’]", "'", s)
    s = re.sub(r"[“”]", '"', s)
    return s.rstrip(".")


def extract_years(text: str) -> set[str]:
    # Non-capturing group: `findall` returns whatever it captures, so a
    # capturing `(19|20)\d{2}` here would silently return just "19"/"20"
    # instead of the full year — which made this check a no-op that always
    # "matched" (every modern year starts with one of those two prefixes).
    return set(re.findall(r"(?:19|20)\d{2}", text or ""))


def _issue(issues: list[dict], level: str, check: str, message: str) -> None:
    issues.append({"level": level, "check": check, "message": message})


def check_course(state: str, course: str, chunks: list[dict], manifest_row: dict) -> dict:
    issues: list[dict] = []

    if not chunks:
        _issue(issues, "error", "non_empty", "No chunks were produced.")

    # CSP genuinely republishes the same standard under several
    # standard-set "packagings" of one course (semester split, full year,
    # accelerated placement) — same code, same text. That's not an error;
    # only a code reused for genuinely different text is (a real collision,
    # e.g. two different courses' standards colliding on notation).
    seen_keys: dict[tuple, tuple[int, str]] = {}
    for index, chunk in enumerate(chunks):
        for field in REQUIRED_FIELDS:
            if field not in chunk or chunk.get(field) in (None, ""):
                _issue(issues, "error", "required_fields", f"chunk {index} is missing `{field}`")

        grade = chunk.get("grade")
        if isinstance(grade, bool) or not isinstance(grade, int) or not (0 <= grade <= 12 or grade == 99):
            _issue(issues, "error", "grade_domain", f"chunk {index} has invalid grade {grade!r}")

        if chunk.get("state") != state:
            _issue(issues, "error", "state_scope", f"chunk {index} is not tagged state {state!r}")

        code = str(chunk.get("code", ""))
        if code and code not in str(chunk.get("embed_text", "")):
            _issue(issues, "error", "embedding_contract", f"chunk {index} embed text omits its code")

        desc_norm = norm_text(chunk.get("description", ""))
        key = (chunk.get("state"), course, grade, code)
        if key in seen_keys:
            prev_index, prev_desc, prev_section = seen_keys[key]
            section = chunk.get("source_page_or_section", "")
            if prev_desc != desc_norm:
                if section != prev_section:
                    # Same broad `course` (e.g. "Social_Studies") bucketed two
                    # genuinely distinct state standard-set documents that
                    # happen to reuse the same code numbering independently —
                    # seen for TN's two separate Grade 8 US History courses
                    # and FL's two Grade 6 World History sets, same root cause
                    # as the grade-99 HS-elective case. Real ambiguity for a
                    # bare-code citation lookup, but a course-granularity gap
                    # (this `course` should probably be split further), not
                    # corrupted data. Downgraded to warning and tracked as a
                    # follow-up rather than blocking the whole subject.
                    _issue(
                        issues, "warning", "elective_code_collision",
                        f"code {code!r} means different things in {section!r} vs {prev_section!r} (chunk {index} vs {prev_index}) — course granularity is too coarse here",
                    )
                else:
                    level = "warning" if manifest_row.get("source_kind") == "csp_only" else "error"
                    check = "source_code_collision" if level == "warning" else "duplicate_identity"
                    _issue(
                        issues, level, check,
                        f"code {code!r} reused at chunk {index} with different text than chunk {prev_index} within the same standard set {section!r} — retained for source audit",
                    )
        else:
            seen_keys[key] = (index, desc_norm, chunk.get("source_page_or_section", ""))

    # Near-duplicate detection: two different codes with the identical
    # normalized description text, within the same course/grade — usually a
    # CSP parent/child pair extracted twice rather than a real duplicate
    # standard, but worth a human's eyes before activating.
    by_norm_desc: dict[tuple, list[str]] = defaultdict(list)
    for chunk in chunks:
        key = (chunk.get("grade"), norm_text(chunk.get("description", "")))
        by_norm_desc[key].append(str(chunk.get("code", "")))
    near_dupes = {k: v for k, v in by_norm_desc.items() if len(set(v)) > 1}
    for (grade, desc), codes in list(near_dupes.items())[:10]:
        _issue(issues, "warning", "near_duplicate", f"grade {grade}: codes {sorted(set(codes))} share identical text: {desc[:100]!r}")

    # Version check: does the manifest's independently-researched
    # adopted_title share at least one year token with what was actually
    # fetched? A CSP subject string with no overlapping year is exactly the
    # AL Counseling/DLCS/World-Languages pattern from the earlier session —
    # CSP silently behind the real adopted revision.
    adopted_years = extract_years(manifest_row.get("adopted_title", ""))
    fetched_subjects = {c.get("csp_subject", "") for c in chunks if c.get("csp_subject")}
    fetched_years: set[str] = set()
    for s in fetched_subjects:
        fetched_years |= extract_years(s)
    version_mismatch = bool(adopted_years) and bool(fetched_years) and not (adopted_years & fetched_years)
    if version_mismatch:
        _issue(
            issues, "error", "version_mismatch",
            f"manifest adopted_title years {sorted(adopted_years)} share nothing with CSP's fetched subject years {sorted(fetched_years)} ({sorted(fetched_subjects)})",
        )

    # Regression check: compare against the last count that actually passed
    # this gate (not the last fetch, which may itself be a bad run).
    prev = manifest_row.get("last_verified_count")
    current = len(chunks)
    if prev is not None and prev > 0 and current < prev * 0.7:
        _issue(issues, "error", "regression", f"chunk count dropped from {prev} to {current} (>30% drop) since the last verified run")

    errors = [i for i in issues if i["level"] == "error"]
    warnings = [i for i in issues if i["level"] == "warning"]
    return {
        "ok": not errors,
        "state": state,
        "course": course,
        "chunks": current,
        "errors": errors,
        "warnings": warnings,
        "version_mismatch": version_mismatch,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True)
    parser.add_argument("--only", nargs="*", metavar="COURSE")
    args = parser.parse_args()
    state = args.state.upper()

    rows = manifest_db.get_frameworks(state)
    if args.only:
        rows = [r for r in rows if r["course"] in set(args.only)]

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    overall_ok = True
    report_lines = [f"# Ingest gate: {state}\n"]

    # Sibling counts, for the out-of-family check below. Read up front so
    # every course is measured against the same picture regardless of order.
    sibling_counts: dict[str, int] = {}
    for row in rows:
        p = CHUNKS_DIR / f"{state.lower()}_{row['course'].lower()}_csp_chunks.json"
        if p.exists():
            try:
                sibling_counts[row["course"]] = len(json.loads(p.read_text()))
            except (OSError, json.JSONDecodeError):
                pass

    for row in rows:
        course = row["course"]
        chunks_path = CHUNKS_DIR / f"{state.lower()}_{course.lower()}_csp_chunks.json"
        if not chunks_path.exists():
            # A course the manifest expects but that produced no file at all
            # is a FAILURE, not a skip. Delaware's Social Studies vanished
            # this way — its leaf items were typed "Grade Level Expectation",
            # which the ingester didn't recognise, so 85 standards silently
            # became zero and the gate waved it through as "not fetched yet".
            # Only a row nobody has claimed yet (never started, no source) is
            # allowed to be quiet about it.
            if row.get("status") in ("not_started", "deprecated") and not row.get("last_verified_count"):
                print(f"SKIP  [{course}] not ingested yet (status={row.get('status')})")
            else:
                print(f"FAIL  [{course}] produced NO output file — expected data for a {row.get('status')} course")
                overall_ok = False
                report_lines.append(
                    f"\n## {course}\n- **ERROR** (no_output): the manifest expects this course but the "
                    f"ingester wrote no file. Most often the source types its leaf items with a name "
                    f"the ingester does not recognise, so every standard is filtered out.\n"
                )
            continue

        chunks = json.loads(chunks_path.read_text())
        result = check_course(state, course, chunks, row)

        # Out-of-family check. The gate validates that records are well
        # formed; it cannot tell that the ingester grabbed the wrong LEVEL of
        # a hierarchy. Oklahoma kept 117 strand headers instead of 774
        # objectives and passed; North Carolina dropped ~300 objectives per
        # course and passed; Wisconsin shipped 33 chunks where its siblings
        # had hundreds. What all three have in common is a count wildly out
        # of family with the state's other subjects, which is cheap to spot
        # even when every individual record looks perfect.
        others = sorted(v for c, v in sibling_counts.items() if c != course and v > 0)
        if others and len(others) >= 2:
            median = others[len(others) // 2]
            if result["chunks"] < median * 0.25:
                level = "warning" if row.get("source_kind") == "csp_only" else "error"
                issue = {
                    "level": level,
                    "check": "coverage_out_of_family" if level == "warning" else "out_of_family",
                    "message": (
                        f"{result['chunks']} records is far below this state's other subjects "
                        f"(median {median}). CSP may not publish the same breadth for this "
                        f"course; verify against the official state source before treating it "
                        f"as complete."
                    ),
                }
                (result["warnings"] if level == "warning" else result["errors"]).append(issue)
                if level == "error":
                    result["ok"] = False

        overall_ok = overall_ok and result["ok"]

        status = "PASS" if result["ok"] else "FAIL"
        print(f"{status} [{course}] {result['chunks']} chunks, {len(result['errors'])} errors, {len(result['warnings'])} warnings")
        for item in result["errors"]:
            print(f"  ERROR {item['check']}: {item['message']}")
        for item in result["warnings"][:5]:
            print(f"  WARN  {item['check']}: {item['message']}")

        new_status = row["status"]
        if result["version_mismatch"]:
            new_status = "stale"
        elif result["ok"]:
            # A course that is already live and still passes stays live.
            # Demoting it to 'staged' would pull a working state out of the
            # app just for re-running the gate — which is exactly what
            # happened to Georgia and Florida the first time this check was
            # re-run over already-shipped data.
            new_status = row["status"] if row["status"] == "active" else "staged"
        manifest_db.update_framework(
            state, course,
            status=new_status,
            match_pct=None,
            last_verified_count=result["chunks"] if result["ok"] else row.get("last_verified_count"),
            # Strip any previous run's own "| gate: ..." suffix before adding
            # this run's, rather than appending forever — re-running the
            # gate a few times while fixing a bug was turning `notes` into a
            # stacked history of every past attempt instead of the current
            # state.
            notes=(row.get("notes") or "").split(" | gate:")[0] + f" | gate: {'PASS' if result['ok'] else 'FAIL'} ({len(result['errors'])} errors)",
        )

        report_lines.append(f"\n## {course}\n")
        report_lines.append(f"- Status after gate: `{new_status}`\n- {result['chunks']} chunks, {len(result['errors'])} errors, {len(result['warnings'])} warnings\n")
        for item in result["errors"]:
            report_lines.append(f"- **ERROR** ({item['check']}): {item['message']}\n")
        for item in result["warnings"][:10]:
            report_lines.append(f"- WARN ({item['check']}): {item['message']}\n")

    report_path = REPORTS_DIR / f"ingest-gate-{state.lower()}.md"
    report_path.write_text("".join(report_lines))
    print(f"\nReport: {report_path}")
    print("GATE " + ("PASS" if overall_ok else "FAIL — see errors above; no row was auto-activated regardless"))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
