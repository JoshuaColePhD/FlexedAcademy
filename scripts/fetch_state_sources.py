#!/usr/bin/env python3
"""Snapshot one state's CASE packages and source PDFs, and record their hashes.

THE ONLY PART OF THE INGEST THAT TOUCHES THE NETWORK. Everything downstream —
parsing, the quality gate, embedding — runs off the snapshots this writes, which
is what makes an ingest reproducible and reviewable: the diff in the fetch PR is
the evidence of what the state actually published on that date.

It also means the ingest can be developed in an environment with no route to a
state DOE at all, which is not hypothetical. Claude Code web sessions run behind
an egress policy that denies alabamastandards.org and case.georgiastandards.org
outright, so this runs in CI (see .github/workflows/fetch-state-standards.yml)
rather than wherever the code happens to be edited.

    python scripts/fetch_state_sources.py --state GA
    python scripts/fetch_state_sources.py --state GA --no-pdfs
    python scripts/fetch_state_sources.py --state AL --refresh

What it writes back into the manifest, per source: `case_id`, `framework`,
`url` (the publisher's own officialSourceURL), `version`, `retrieved_at`,
`package_sha256` and, when the PDF was fetched, `sha256`.

What it deliberately does NOT write: `course` and `course_map`. Which framework
a teacher's class binds to is a judgement about that state's course catalogue,
made by a person and reviewed in the PR. A fetch script inventing it is exactly
the guessing the standards-ingestion skill forbids — so new sources arrive with
`course: TODO` and the ingest refuses to run until someone resolves them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import state_manifest  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CASE_CACHE_ROOT = PROJECT_ROOT / "data" / "raw" / "case"
TIMEOUT = 120
TODO = "TODO"

log = logging.getLogger("fetch")


def _get(url: str) -> bytes:
    log.info("  GET %s", url)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _package_fingerprint(pkg: dict) -> str:
    """Key-order-independent, so re-serialising a package cannot change its hash."""
    payload = json.dumps(pkg, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _sha256(payload.encode())


def _slug(title: str) -> str:
    """A stable source_id from a framework title: 'Social Studies' -> Social_Studies."""
    cleaned = re.sub(r"\(.*?\)", "", title)
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", cleaned).strip("_")
    return cleaned or "Framework"


def list_documents(case_api: str) -> list[dict]:
    """Every framework the state's CASE server publishes.

    CASE servers page this endpoint inconsistently, so both the paged envelope
    and a bare list are accepted rather than assuming one shape.
    """
    raw = json.loads(_get(f"{case_api.rstrip('/')}/CFDocuments").decode("utf-8"))
    if isinstance(raw, list):
        return raw
    return raw.get("CFDocuments") or raw.get("cfDocuments") or []


def fetch_state(state_code: str, *, refresh: bool, want_pdfs: bool) -> int:
    manifest = state_manifest.load(state_code)
    code = manifest.state_code
    log.info("%s — %s", manifest.state, manifest.case_api)

    cache = CASE_CACHE_ROOT / code
    cache.mkdir(parents=True, exist_ok=True)
    pdf_dir = PROJECT_ROOT / (manifest.pdf_dir or f"data/raw/source_docs/{code}")

    try:
        documents = list_documents(manifest.case_api)
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        log.error("could not list CFDocuments for %s: %s", code, exc)
        return 1
    if not documents:
        log.error("%s published no CFDocuments — nothing to snapshot.", code)
        return 1
    log.info("%d framework(s) published", len(documents))

    # source_id is preserved for frameworks already in the manifest, so a
    # refresh updates provenance in place instead of renaming things the
    # course_map points at.
    known_by_case_id = {s.case_id: s for s in manifest.sources}

    entries: list[dict] = []
    for document in documents:
        case_id = document.get("identifier") or document.get("id")
        title = (document.get("title") or "").strip()
        if not case_id:
            log.warning("  skipping a CFDocument with no identifier: %r", title)
            continue

        path = cache / f"{case_id}.json"
        if refresh or not path.is_file():
            try:
                path.write_bytes(_get(f"{manifest.case_api.rstrip('/')}/CFPackages/{case_id}"))
            except urllib.error.URLError as exc:
                log.error("  FAILED package %s (%s): %s", title, case_id, exc)
                continue
        package = json.loads(path.read_text(encoding="utf-8"))
        cf_document = package.get("CFDocument", {}) or {}

        existing = known_by_case_id.get(case_id)
        official_url = cf_document.get("officialSourceURL") or document.get("officialSourceURL")

        pdf_name = existing.pdf if existing else None
        pdf_sha = None
        if want_pdfs and official_url and official_url.lower().endswith(".pdf"):
            pdf_name = pdf_name or f"{_slug(title)}.pdf"
            pdf_path = pdf_dir / pdf_name
            if refresh or not pdf_path.is_file():
                try:
                    pdf_dir.mkdir(parents=True, exist_ok=True)
                    pdf_path.write_bytes(_get(official_url))
                except urllib.error.URLError as exc:
                    # The PDF is the verification target, not the input — losing
                    # it degrades the verbatim check, it does not block ingest.
                    log.warning("  PDF unavailable for %s: %s", title, exc)
                    pdf_name = None
            if pdf_name and (pdf_dir / pdf_name).is_file():
                pdf_sha = _sha256((pdf_dir / pdf_name).read_bytes())

        entries.append({
            "source_id": existing.source_id if existing else _slug(title),
            # Left as TODO for a new framework on purpose: which course a teacher
            # selects to reach these standards is a person's call, reviewed in
            # this PR, not something a fetch may invent.
            "course": existing.course if existing else TODO,
            "framework": title,
            "case_id": case_id,
            "pdf": pdf_name,
            "format": "case",
            "source_type": "state_course_of_study",
            "url": official_url,
            "version": (cf_document.get("lastChangeDateTime")
                        or cf_document.get("statusStartDate")
                        or cf_document.get("identifier")),
            "retrieved_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "package_sha256": _package_fingerprint(package),
            "sha256": pdf_sha,
        })

    if not entries:
        log.error("nothing snapshotted for %s", code)
        return 1

    out = PROJECT_ROOT / "data" / "raw" / f"{code}_FETCH.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    todo = [e for e in entries if e["course"] == TODO]
    log.info("")
    log.info("Snapshotted %d framework(s) to %s", len(entries), out.relative_to(PROJECT_ROOT))
    log.info("Packages:    %s", (cache).relative_to(PROJECT_ROOT))
    if want_pdfs:
        log.info("Source PDFs: %s", pdf_dir)
    if todo:
        log.info("")
        log.info("%d framework(s) need a `course` and a course_map entry before "
                 "%s can be ingested:", len(todo), code)
        for entry in todo:
            log.info("    %-28s %s", entry["source_id"], entry["framework"])
        log.info("")
        log.info("Paste these into scripts/state_manifests/%s.yaml, resolve each "
                 "TODO against the state's published course list, and record "
                 "license_or_usage from the publisher's actual terms.", code.lower())
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--state", required=True, metavar="CODE",
                    help=f"two-letter state code. Have: "
                         f"{', '.join(state_manifest.available_states())}")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download packages and PDFs already cached")
    ap.add_argument("--no-pdfs", action="store_true",
                    help="snapshot CASE packages only, skipping the source PDFs")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        return fetch_state(args.state, refresh=args.refresh, want_pdfs=not args.no_pdfs)
    except state_manifest.ManifestError as exc:
        log.error("%s", exc)
        return 1


if __name__ == "__main__":
    sys.exit(main())
