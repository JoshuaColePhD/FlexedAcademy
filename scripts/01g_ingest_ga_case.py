#!/usr/bin/env python3
"""Ingest Georgia's standards directly from its own official CASE feed
(case.georgiastandards.org) instead of the Common Standards Project.

Georgia, like Alabama, publishes a first-party CASE 1.0/1.1 feed — this
session's comparison of CSP's copy against that feed found CSP was strong on
wording (96-99.7% exact text once a code matched) but had real coverage
gaps: an entire high-school course (Advanced Financial Algebra) missing from
Math, and ~300 Social Studies codes CSP didn't carry. Pulling from Georgia's
own feed directly (the same fix already applied to Alabama and Mississippi
Math) closes both gaps in one motion instead of patching CSP's copy.

Usage:
    python scripts/01g_ingest_ga_case.py
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "data" / "processed"
RAW_DIR = PROJECT_ROOT / "data" / "raw" / "ga_case"
BASE_URL = "https://case.georgiastandards.org/ims/case/v1p1/CFPackages"

# course -> (CASE CFDocument identifier, friendly official source page)
FRAMEWORKS = {
    "ELA": ("391c3abe-c1ec-4a4a-a942-c9e152b35102", "English Language Arts - Georgia Department of Education"),
    "Math": ("e9dd7229-3558-4df2-85c6-57b8938f6180", "Georgia's K-12 Mathematics Standards"),
    "Science": ("27a08dc6-416e-11e7-ba71-02bd89fdd987", "Science - Georgia Standards of Excellence"),
    "Social_Studies": ("a446e74c-463e-11e7-94f5-b49cee8b2d8c", "Social Studies - Georgia Department of Education"),
}

LEAF_TYPES = {"Standard", "Expectation", "Content Standard", "Element"}
GRADE_MAP = {"KG": 0, **{f"{i:02d}": i for i in range(1, 13)}}

STATE = "GA"


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            print(f"HTTP {e.code} for {url}", file=sys.stderr)
            if e.code == 429:
                time.sleep(5)
                continue
            raise
    raise RuntimeError(f"failed to fetch {url}")


def clean_statement(text: str) -> str:
    # Cluster-heading prefixes are wrapped in **bold** at the front of some
    # items' own fullStatement ("**Grammar, Usage, & Mechanics** Learn and
    # apply..."). Keep the substance, drop the markdown bold marker itself.
    text = re.sub(r"\*\*", "", text or "")
    return re.sub(r"\s+", " ", text).strip()


def grade_from_levels(levels: list[str]) -> int:
    if not levels:
        return 99
    mapped = {GRADE_MAP.get(lv) for lv in levels}
    if len(mapped) == 1 and None not in mapped:
        return next(iter(mapped))
    return 99  # multi-grade or unrecognized -> ungraded/course-level bucket, same convention as the CSP path


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC).isoformat()

    for course, (doc_id, source_label) in FRAMEWORKS.items():
        cache_path = RAW_DIR / f"{course.lower()}.json"
        if cache_path.exists():
            print(f"{course}: using cached {cache_path}")
            data = json.loads(cache_path.read_text())
        else:
            print(f"{course}: fetching CFPackage {doc_id}...")
            data = fetch_json(f"{BASE_URL}/{doc_id}")
            cache_path.write_text(json.dumps(data))

        items = {it["identifier"]: it for it in data["CFItems"]}
        # isChildOf: origin is the child, destination is the parent.
        parent_of: dict[str, str] = {}
        for a in data["CFAssociations"]:
            if a.get("associationType") == "isChildOf":
                parent_of[a["originNodeURI"]["identifier"]] = a["destinationNodeURI"]["identifier"]

        def nearest_course_ancestor(item_id: str, depth: int = 0) -> dict | None:
            if depth > 15 or item_id not in parent_of:
                return None
            parent_id = parent_of[item_id]
            parent = items.get(parent_id)
            if parent and parent.get("CFItemType") == "Course":
                return parent
            return nearest_course_ancestor(parent_id, depth + 1)

        def parent_statement(item_id: str) -> tuple[str | None, str | None]:
            parent_id = parent_of.get(item_id)
            parent = items.get(parent_id) if parent_id else None
            if not parent:
                return None, None
            return parent.get("humanCodingScheme"), clean_statement(parent.get("fullStatement", ""))

        chunks = []
        seen_exact: set[tuple] = set()
        for item_id, it in items.items():
            code = it.get("humanCodingScheme")
            if not code or it.get("CFItemType") not in LEAF_TYPES:
                continue
            description = clean_statement(it.get("fullStatement", ""))
            if not description:
                continue

            grade = grade_from_levels(it.get("educationLevel") or [])
            course_node = nearest_course_ancestor(item_id)
            section = course_node.get("fullStatement") if course_node else source_label
            parent_code, parent_text = parent_statement(item_id)

            exact_key = (grade, code, description)
            if exact_key in seen_exact:
                continue
            seen_exact.add(exact_key)

            chunks.append({
                "code": code,
                "description": description,
                "course": course,
                "grade": grade,
                "state": STATE,
                "source_type": "state_course_of_study",
                "source_document": source_label,
                "source_page_or_section": section,
                "strand": None,
                "parent_code": parent_code,
                "parent_text": parent_text,
                "notes": [],
                "embed_text": f"[{code}] {description}" + (f" (Under: {parent_text})" if parent_text else ""),
                "verbatim_ok": True,  # sourced directly from Georgia's own CASE feed, no paraphrase
                "official_source_url": f"https://case.georgiastandards.org/ims/case/v1p1/CFDocuments/{doc_id}",
                "case_item_uri": it.get("uri"),
                "source_case_id": doc_id,
                "source_ingested_at": now,
                "csp_subject": None,
                "csp_standard_set_id": None,
            })

        out_path = OUT_DIR / f"ga_{course.lower()}_csp_chunks.json"
        out_path.write_text(json.dumps(chunks, indent=2))
        print(f"  {len(chunks)} chunks -> {out_path}")

    print("Done. Run scripts/ingest_gate.py --state GA to verify before re-embedding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
