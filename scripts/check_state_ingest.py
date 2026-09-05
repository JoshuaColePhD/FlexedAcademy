"""Quality gate for a state's CASE ingestion output.

Generalised from check_alabama_ingest.py, which is now a thin wrapper over this.
Intentionally deterministic and dependency-free apart from the manifest loader.
It validates the contract between a state adapter, its PDF verification report,
and the records that will be embedded. A failed gate means the output should not
be uploaded or used to rebuild a corpus.

Beyond the per-chunk checks, this is where the course_map is held to account:
every binding must reach standards that were actually parsed, and every parsed
standard must be reachable from some binding. See _check_course_map.

Usage:
    python scripts/check_state_ingest.py --state AL
    python scripts/check_state_ingest.py --state GA --grades 0-12
    python scripts/check_state_ingest.py --state AL --only ELA Math
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:  # works both as `python scripts/check_state_ingest.py` and as a test import
    from . import state_manifest
except ImportError:  # pragma: no cover - direct script execution path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import state_manifest

PROJECT_ROOT = Path(__file__).resolve().parent.parent

REQUIRED_FIELDS = (
    "code", "description", "course", "grade", "state", "source_type",
    "source_document", "case_framework", "official_source_url", "embed_text",
    "source_case_id", "source_version", "source_package_sha256", "source_ingested_at",
)


def parse_grades(spec: str) -> frozenset[int]:
    grades: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _, hi = part.partition("-")
            grades.update(range(int(lo), int(hi) + 1))
        else:
            grades.add(int(part))
    if not grades or any(g < 0 or g > 12 for g in grades):
        raise ValueError(f"invalid grade scope: {spec!r}")
    return frozenset(grades)


def _missing(value: Any) -> bool:
    # Do not use `if not value`: Kindergarten is represented by grade 0.
    return value is None or (isinstance(value, str) and not value.strip())


def _issue(issues: list[dict], level: str, check: str, message: str, course: str | None = None) -> None:
    item = {"level": level, "check": check, "message": message}
    if course:
        item["course"] = course
    issues.append(item)


def _unique_standards(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Collapse one CASE item copied to several grades to one source standard."""
    unique: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (str(row.get("code", "")), str(row.get("description", "")))
        unique.setdefault(key, row)
    return unique


def check_ingest(
    chunks: list[dict],
    report: list[dict],
    *,
    manifest,
    check_bindings: bool = True,
    expected_courses: set[str] | frozenset[str] | None = None,
    expected_grades: set[int] | frozenset[int] | None = None,
    require_pdf_verification: bool = True,
) -> dict:
    """Return a JSON-serializable quality result with errors and warnings."""
    STATE = manifest.state_code
    expected = set(expected_courses or manifest.framework_ids)
    issues: list[dict] = []
    by_course: dict[str, list[dict]] = defaultdict(list)

    if not chunks:
        _issue(issues, "error", "non_empty", "No chunks were produced.")

    seen_keys: dict[tuple[Any, ...], int] = {}
    for index, chunk in enumerate(chunks):
        course = str(chunk.get("course") or "")
        by_course[course].append(chunk)

        for field in REQUIRED_FIELDS:
            if field not in chunk or _missing(chunk.get(field)):
                _issue(issues, "error", "required_fields", f"chunk {index} is missing `{field}`", course)

        grade = chunk.get("grade")
        if isinstance(grade, bool) or not isinstance(grade, int) or not 0 <= grade <= 12:
            _issue(issues, "error", "grade_domain", f"chunk {index} has invalid grade {grade!r}", course)
        elif expected_grades is not None and grade not in expected_grades:
            _issue(issues, "error", "grade_scope", f"chunk {index} is outside requested grade scope: {grade}", course)

        if chunk.get("state") != STATE:
            _issue(issues, "error", "state_scope", f"chunk {index} is not tagged state {STATE!r}", course)
        if chunk.get("source_type") != "state_course_of_study":
            _issue(issues, "error", "source_type", f"chunk {index} is not a state course-of-study record", course)

        for flag in ("verbatim_ok", "wordwise_ok"):
            if not isinstance(chunk.get(flag), bool):
                _issue(issues, "error", "verification_flags", f"chunk {index} has non-boolean `{flag}`", course)
        if chunk.get("verbatim_ok") and not chunk.get("wordwise_ok"):
            _issue(issues, "error", "verification_flags", f"chunk {index} is byte-exact but not wordwise verified", course)
        if not isinstance(chunk.get("notes"), list):
            _issue(issues, "error", "metadata_types", f"chunk {index} has non-list `notes`", course)

        parsed = urlparse(str(chunk.get("official_source_url") or ""))
        if parsed.scheme != "https" or not parsed.netloc:
            _issue(issues, "error", "source_url", f"chunk {index} has an invalid official source URL", course)
        if str(chunk.get("code", "")) not in str(chunk.get("embed_text", "")):
            _issue(issues, "error", "embedding_contract", f"chunk {index} embed text omits its code", course)
        for field in ("source_package_sha256", "source_pdf_sha256"):
            value = chunk.get(field)
            if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)):
                _issue(issues, "error", "source_fingerprint", f"chunk {index} has invalid `{field}`", course)
        if not isinstance(chunk.get("source_ingested_at"), str) or not chunk.get("source_ingested_at", "").strip():
            _issue(issues, "error", "source_provenance", f"chunk {index} has no source ingestion timestamp", course)

        key = (chunk.get("state"), course, grade, chunk.get("code"))
        if key in seen_keys:
            _issue(
                issues, "error", "duplicate_identity",
                f"duplicate (state, course, grade, code); first seen at chunk {seen_keys[key]}", course,
            )
        else:
            seen_keys[key] = index

    actual_courses = {course for course in by_course if course}
    for course in sorted(expected - actual_courses):
        _issue(issues, "error", "framework_roster", "expected framework produced no chunks", course)
    for course in sorted(actual_courses - expected):
        _issue(issues, "error", "framework_roster", "unexpected framework in Alabama output", course)

    report_by_course: dict[str, dict] = {}
    for row in report:
        course = str(row.get("course") or "")
        if course in report_by_course:
            _issue(issues, "error", "report_identity", "duplicate report row", course)
        report_by_course[course] = row

    for course in sorted(expected - set(report_by_course)):
        _issue(issues, "error", "report_roster", "expected framework has no report row", course)
    for course in sorted(set(report_by_course) - expected):
        _issue(issues, "error", "report_roster", "report contains an unexpected framework", course)

    summaries: dict[str, dict] = {}
    for course in sorted(expected & actual_courses):
        rows = by_course[course]
        unique = _unique_standards(rows)
        report_row = report_by_course.get(course)
        if report_row is None:
            continue

        flags_by_standard: dict[tuple[str, str], set[tuple[Any, Any]]] = defaultdict(set)
        for row in rows:
            flags_by_standard[(str(row.get("code", "")), str(row.get("description", "")))].add(
                (row.get("verbatim_ok"), row.get("wordwise_ok"))
            )
        if any(len(flags) != 1 for flags in flags_by_standard.values()):
            _issue(issues, "error", "verification_consistency", "the same standard has inconsistent verification flags across grades", course)

        derived = {
            "chunks": len(rows),
            "standards": len(unique),
            "verbatim_ok": sum(bool(row.get("verbatim_ok")) for row in unique.values()),
            "wordwise_ok": sum(bool(row.get("wordwise_ok")) for row in unique.values()),
            "grades": sorted({row.get("grade") for row in rows}),
        }
        derived["unmatched"] = derived["standards"] - derived["wordwise_ok"]
        derived["wordwise_rate"] = round(derived["wordwise_ok"] / derived["standards"] * 100, 1) if derived["standards"] else 0.0

        for field in ("chunks", "standards", "verbatim_ok", "wordwise_ok", "unmatched", "grades"):
            if report_row.get(field) != derived[field]:
                _issue(issues, "error", "report_consistency", f"report `{field}`={report_row.get(field)!r}, derived {derived[field]!r}", course)

        source_urls = {str(row.get("official_source_url") or "") for row in rows}
        if len(source_urls) != 1 or report_row.get("official_source_url") not in source_urls:
            _issue(issues, "error", "source_consistency", "chunk source URLs disagree with the report", course)
        if not report_row.get("framework"):
            _issue(issues, "error", "report_fields", "report is missing its framework title", course)
        if not report_row.get("pdf"):
            _issue(issues, "error", "report_fields", "report is missing its PDF path", course)

        for field in ("source_case_id", "source_version", "source_package_sha256", "source_pdf_sha256"):
            values = {row.get(field) for row in rows}
            if len(values) != 1 or report_row.get(field) not in values or _missing(report_row.get(field)):
                _issue(issues, "error", "source_provenance", f"chunk/report `{field}` values disagree", course)

        if report_row.get("pdf_text_available") is not True:
            level = "error" if require_pdf_verification else "warning"
            _issue(issues, level, "pdf_verification", "the local PDF was unavailable; source fidelity was not checked", course)

        if derived["wordwise_rate"] < 90.0:
            _issue(issues, "warning", "source_fidelity", f"wording verification is {derived['wordwise_rate']:.1f}%", course)
        if derived["wordwise_rate"] < 60.0:
            _issue(issues, "error", "source_fidelity", f"wording verification is critically low at {derived['wordwise_rate']:.1f}%", course)

        summaries[course] = derived | {
            "reported_wordwise_rate": report_row.get("wordwise_rate"),
            "official_source_url": report_row.get("official_source_url"),
            "source_case_id": report_row.get("source_case_id"),
            "source_version": report_row.get("source_version"),
            "source_package_sha256": report_row.get("source_package_sha256"),
            "source_pdf_sha256": report_row.get("source_pdf_sha256"),
        }

    if check_bindings:
        _check_course_map(manifest, by_course, expected, expected_grades, issues)

    errors = [item for item in issues if item["level"] == "error"]
    warnings = [item for item in issues if item["level"] == "warning"]
    return {
        "ok": not errors,
        "state": STATE,
        "chunks": len(chunks),
        "frameworks": sorted(actual_courses),
        "errors": errors,
        "warnings": warnings,
        "summaries": summaries,
    }


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)




def _check_course_map(manifest, by_course: dict, expected_courses, expected_grades, issues: list[dict]) -> None:
    """The class -> standards binding must agree with what was actually parsed.

    Checked in BOTH directions, because each catches a different silent failure:

      * A dangling target is a subject the app offers, bound to a framework that
        produced nothing. A teacher selects it, retrieval finds no rows, and the
        app reports "nothing relevant" — indistinguishable from a bad query.
      * An orphan chunk is a standard nobody can reach. It embeds, it costs, it
        sits in the corpus, and no (subject, grade) resolves to it.

    Together they are what makes "deterministic binding" a property rather than
    an intention: the map and the corpus have to describe the same thing.

    A scaffold manifest with no course_map yet is a warning, not an error. It is
    the honest state of a half-added state, and the ingest driver already refuses
    to run one that has no sources.
    """
    if not manifest.course_map:
        _issue(issues, "warning", "course_map",
               f"{manifest.state_code} has no course_map: nothing binds a class to these "
               f"standards yet, so no subject can retrieve them.")
        return

    if expected_grades is None:
        # Totality is a claim about a declared scope. A caller that did not say
        # which grades it was ingesting is not asserting completeness, and
        # judging it against the manifest's full range would report every grade
        # it never asked for as missing. The real ingest always declares a scope.
        _issue(issues, "warning", "course_map",
               "no grade scope declared, so course_map totality was not checked")
        return

    reachable: set[tuple[str, int]] = set()
    for binding in manifest.course_map:
        if binding.source_id is None:
            continue  # national_only: grounded outside this corpus by design
        try:
            source = manifest.source(binding.source_id)
        except state_manifest.ManifestError as exc:
            _issue(issues, "error", "course_map_dangling", str(exc), binding.subject_code)
            continue

        if source.course not in expected_courses:
            # A partial ingest (--only ELA) says nothing about whether the other
            # frameworks' bindings resolve. Reporting them as dangling would make
            # every scoped re-ingest fail on frameworks it never touched.
            continue

        produced = {c.get("grade") for c in by_course.get(source.course, [])}
        if not produced:
            _issue(issues, "error", "course_map_dangling",
                   f"{binding.subject_code} binds to {source.source_id!r}, which produced "
                   f"no chunks in this ingest", source.course)
            continue

        # A binding for a grade outside the ingested scope is a promise the
        # corpus cannot keep. Scoped-out grades are expected, not an error, when
        # the ingest was deliberately narrowed.
        in_scope = set(binding.grades)
        if expected_grades is not None:
            in_scope &= set(expected_grades)
        missing = sorted(in_scope - produced)
        if missing:
            _issue(issues, "error", "course_map_dangling",
                   f"{binding.subject_code} binds grades {missing} to {source.source_id!r}, "
                   f"which produced none of them", source.course)
        for grade in binding.grades:
            reachable.add((source.course, grade))

    for course, course_chunks in by_course.items():
        if course not in expected_courses:
            continue
        for chunk in course_chunks:
            grade = chunk.get("grade")
            if (course, grade) not in reachable:
                _issue(issues, "error", "course_map_orphan",
                       f"{course} grade {grade} was parsed but no course_map entry "
                       f"reaches it — it would be embedded and never retrievable", course)
                break  # one per (course, grade) family is enough to act on


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, metavar="CODE",
                        help=f"two-letter state code. Have: "
                             f"{', '.join(state_manifest.available_states())}")
    parser.add_argument("--chunks", type=Path, default=None)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--only", nargs="*", metavar="COURSE")
    parser.add_argument("--grades", metavar="RANGE",
                        help="optional scope to enforce, e.g. 9-12 or 0-12")
    parser.add_argument("--allow-unverified-source", action="store_true")
    args = parser.parse_args(argv)

    try:
        manifest = state_manifest.load(args.state)
    except state_manifest.ManifestError as exc:
        print(f"QUALITY FAIL — {exc}")
        return 1

    chunks_path = args.chunks or (PROJECT_ROOT / manifest.output)
    if manifest.state_code == "AL":
        default_report = PROJECT_ROOT / "data" / "raw" / "ALCOS_INGEST_REPORT.json"
    else:
        default_report = PROJECT_ROOT / "data" / "raw" / f"{manifest.state_code}_INGEST_REPORT.json"
    report_path = args.report or default_report
    output_path = args.output or chunks_path.with_name(
        f"{manifest.state_code.lower()}_quality_report.json"
    )

    try:
        chunks = load_json(chunks_path)
        report = load_json(report_path)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"QUALITY FAIL — could not read ingest output: {exc}")
        return 1

    expected_courses = set(args.only) if args.only else set(manifest.framework_ids)
    try:
        expected_grades = parse_grades(args.grades) if args.grades else None
    except ValueError as exc:
        parser.error(str(exc))

    result = check_ingest(
        chunks,
        report,
        manifest=manifest,
        expected_courses=expected_courses,
        expected_grades=expected_grades,
        require_pdf_verification=not args.allow_unverified_source,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    for item in result["errors"]:
        print(f"ERROR [{item.get('course', '-')}] {item['check']}: {item['message']}")
    for item in result["warnings"]:
        print(f"WARN  [{item.get('course', '-')}] {item['check']}: {item['message']}")
    status = "PASS" if result["ok"] else "FAIL"
    print(f"QUALITY {status} — {result['chunks']} chunks, "
          f"{len(result['errors'])} errors, {len(result['warnings'])} warnings")
    print(f"Report: {output_path}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
