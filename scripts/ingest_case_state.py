#!/usr/bin/env python3
"""Ingest one state's CASE-published standards into the chunk schema.

The generic entry point over scripts/case_adapter.py. Everything state-specific
comes from scripts/state_manifests/<state>.yaml — the CASE server, the package
roster, the PDFs that verify each package, and the course_map binding a
teacher's (subject, grade) to a framework.

    python scripts/ingest_case_state.py --state GA --grades 0-12
    python scripts/ingest_case_state.py --state AL --only ELA Math
    python scripts/ingest_case_state.py --state AL --dry-run   # compare, write nothing

`--dry-run` is how the Alabama parity gate is run: it re-parses from the cached
packages and reports whether counts and verbatim rates still match
data/raw/ALCOS_INGEST_REPORT.json, without touching the artifact the live corpus
was built from. A refactor of the shared adapter that changes Alabama by one
chunk should fail loudly there rather than quietly ship.

Output is gated before it replaces anything: check_state_ingest.py must pass,
including the course_map totality checks, or the previous artifact stays.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import case_adapter  # noqa: E402
import state_manifest  # noqa: E402
from check_state_ingest import check_ingest  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("ingest")


def _resolve(path_str: str) -> Path:
    """Manifest paths are relative to the repo root unless absolute."""
    path = Path(path_str)
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


def _compare_to_previous(report: list[dict], previous_path: Path) -> int:
    """Report drift against a previous run's per-framework numbers.

    The point of --dry-run. Returns a process exit code so CI can use it: any
    framework whose chunk count or verbatim count moved is a difference someone
    has to explain before it reaches the corpus.
    """
    if not previous_path.is_file():
        log.error("No previous report at %s — nothing to compare against.", previous_path)
        return 1
    previous = {r.get("course"): r for r in json.load(open(previous_path, encoding="utf-8"))}

    drift = 0
    log.info("")
    log.info("Comparing against %s", previous_path.name)
    log.info("%-16s %8s %8s   %8s %8s", "framework", "chunks", "was", "verbatim", "was")
    for row in report:
        course = row.get("course")
        old = previous.get(course)
        if old is None:
            log.error("  %-14s NEW — not in the previous report", course)
            drift += 1
            continue
        same = (row.get("chunks") == old.get("chunks")
                and row.get("verbatim_ok") == old.get("verbatim_ok"))
        marker = "  " if same else "!!"
        log.info("%s%-14s %8s %8s   %8s %8s", marker, course,
                 row.get("chunks"), old.get("chunks"),
                 row.get("verbatim_ok"), old.get("verbatim_ok"))
        if not same:
            drift += 1
    for course in previous:
        if not any(r.get("course") == course for r in report):
            log.error("  %-14s MISSING — present in the previous report", course)
            drift += 1

    log.info("")
    if drift:
        log.error("%d framework(s) differ from the previous ingest.", drift)
        return 1
    log.info("Identical to the previous ingest on every framework.")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--state", required=True, metavar="CODE",
                    help=f"two-letter state code. Have: {', '.join(state_manifest.available_states())}")
    ap.add_argument("--only", nargs="*", metavar="COURSE",
                    help="source ids to ingest (default: all in the manifest)")
    ap.add_argument("--strict", action="store_true",
                    help="drop chunks whose text isn't found verbatim in the PDF")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download the CASE packages instead of using the cache")
    ap.add_argument("--grades", default=None, metavar="RANGE",
                    help="grades to keep, e.g. '9-12', '0-12', '11'. 0 means "
                         "Kindergarten. Defaults to the manifest's default_grades.")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse and compare against the previous report; write nothing")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    try:
        manifest = state_manifest.load(args.state)
    except state_manifest.ManifestError as exc:
        log.error("%s", exc)
        return 1

    if not manifest.is_ingestable:
        # A scaffold manifest is valid, just not filled in yet. Saying so beats
        # an empty ingest that looks like a parser failure.
        log.error(
            "%s has no sources yet. Run scripts/fetch_state_sources.py --state %s "
            "to record them, then author its course_map.",
            manifest.state_code, manifest.state_code,
        )
        return 1

    try:
        keep_grades = state_manifest.parse_grades(args.grades or manifest.default_grades)
    except state_manifest.ManifestError as exc:
        ap.error(str(exc))

    log.info("%s — %s", manifest.state, manifest.authority)
    log.info("Grade scope: %s",
             ", ".join("K" if g == 0 else str(g) for g in sorted(keep_grades)))

    if subprocess.run(["which", "pdftotext"], capture_output=True, check=False).returncode != 0:
        log.warning("pdftotext not found (brew install poppler) — "
                    "chunks will be written with verbatim_ok=false")

    selected = list(manifest.sources)
    if args.only:
        want = {c.lower() for c in args.only}
        selected = [s for s in manifest.sources if s.source_id.lower() in want]
        if not selected:
            log.error("No source matched %s. Known: %s", args.only,
                      ", ".join(s.source_id for s in manifest.sources))
            return 1

    pdf_dir = _resolve(manifest.pdf_dir) if manifest.pdf_dir else PROJECT_ROOT
    if not pdf_dir.is_dir():
        # Not fatal: verification degrades to verbatim_ok=false, and the report
        # says so. Silently producing unverified chunks is what would be bad.
        log.warning("PDF directory %s not found — verbatim verification will be skipped", pdf_dir)

    all_chunks: list[dict] = []
    report: list[dict] = []
    for source in selected:
        try:
            chunks, summary = case_adapter.ingest_framework(
                source.course, source.case_id, source.pdf or "",
                refresh=args.refresh, strict=args.strict, keep_grades=keep_grades,
                state_code=manifest.state_code, pdf_dir=pdf_dir,
                case_api=manifest.case_api,
            )
        except Exception as exc:  # noqa: BLE001 — one bad framework must not lose the rest
            log.error("  FAILED %s: %s", source.source_id, exc)
            report.append({"course": source.course, "error": str(exc)})
            continue
        all_chunks.extend(chunks)
        report.append(summary)

    if not all_chunks:
        log.error("Nothing ingested.")
        return 1

    output_path = _resolve(manifest.output)
    report_path = PROJECT_ROOT / "data" / "raw" / f"{manifest.state_code}_INGEST_REPORT.json"
    # Alabama's report predates per-state naming and other things read it.
    if manifest.state_code == "AL":
        report_path = PROJECT_ROOT / "data" / "raw" / "ALCOS_INGEST_REPORT.json"

    if args.dry_run:
        log.info("")
        log.info("--dry-run: parsed %d chunks, wrote nothing.", len(all_chunks))
        return _compare_to_previous(report, report_path)

    quality = check_ingest(
        all_chunks,
        report,
        manifest=manifest,
        expected_courses={s.course for s in selected},
        expected_grades=keep_grades,
    )
    for issue in quality["errors"]:
        log.error("QUALITY ERROR [%s] %s: %s",
                  issue.get("course", "-"), issue["check"], issue["message"])
    for issue in quality["warnings"]:
        log.warning("QUALITY WARNING [%s] %s: %s",
                    issue.get("course", "-"), issue["check"], issue["message"])
    if not quality["ok"]:
        log.error("Ingestion quality gate failed; existing output was not replaced.")
        return 1

    # Merge, don't clobber, when only some frameworks were requested.
    if args.only and output_path.is_file():
        with open(output_path, encoding="utf-8") as f:
            existing = json.load(f)
        kept = {s.course for s in selected}
        preserved = [c for c in existing if c.get("course") not in kept]
        log.info("Merging with %d preserved chunks from other frameworks", len(preserved))
        all_chunks = preserved + all_chunks

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_chunks, f, indent=2, ensure_ascii=False)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    quality_path = output_path.with_name(f"{manifest.state_code.lower()}_quality_report.json")
    with open(quality_path, "w", encoding="utf-8") as f:
        json.dump(quality, f, indent=2, ensure_ascii=False)

    log.info("")
    log.info("Wrote %d chunks to %s", len(all_chunks), output_path.name)
    log.info("Per-framework report: %s", report_path.relative_to(PROJECT_ROOT))
    log.info("Quality report: %s", quality_path.relative_to(PROJECT_ROOT))
    ok = sum(r.get("verbatim_ok", 0) for r in report)
    words = sum(r.get("wordwise_ok", 0) for r in report)
    tot = sum(r.get("standards", 0) for r in report)
    if tot:
        log.info("Verified against the local PDFs (%d standards):", tot)
        log.info("  byte-exact ....... %d (%.1f%%)", ok, ok / tot * 100)
        log.info("  wording intact ... %d (%.1f%%)", words, words / tot * 100)
        log.info("  unmatched ........ %d (%.1f%%)", tot - words, (tot - words) / tot * 100)
    log.info("Next: python scripts/02_embed_store.py --state %s", manifest.state_code)
    return 0


if __name__ == "__main__":
    sys.exit(main())
