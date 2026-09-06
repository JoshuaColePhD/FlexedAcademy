#!/usr/bin/env python3
"""Ingest any state's standards from that state's OWN public CASE feed.

Generalizes scripts/01g_ingest_ga_case.py (Georgia-only) to every state that
publishes a first-party CASE API. A survey of all 50 states found 18 that do
— nearly all of them hosted on Standards Satchel (Common Good Learning
Tools), in three URL shapes, all speaking the same CASE 1.0/1.1 REST binding
Alabama and Georgia already use.

A state's own feed beats the Common Standards Project on two axes that
matter: it carries every subject the state publishes (CSP's Alabama coverage
was missing whole frameworks) and it is the state itself rather than a
re-import of ASN (which is why CSP's Mississippi Math was nine years stale
and its Georgia Math was missing an entire course). It is NOT automatically
fresher, though — Texas's feed is frozen at 2020 — so the manifest's version
check still runs on these exactly as it does on CSP.

The CASE spec leaves real room for variation, and states use it. This
absorbs the three differences seen in practice:

  * Leaf type lives in `CFItemType` (Georgia), `Type` (Florida), or only in
    `CFItemTypeURI.title`. All three are checked.
  * Grade codes are "KG"/"01" (Georgia) or "K"/"1" (Florida).
  * The package id is usually the document id, but Florida's `CFPackageURI`
    points at a different guid — fetching the document id there 404s.

Usage:
    python scripts/01h_ingest_state_case.py --discover FL   # list a state's documents
    python scripts/01h_ingest_state_case.py --state FL
    python scripts/01h_ingest_state_case.py --state FL --only ELA Math
"""

from __future__ import annotations

import argparse
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
RAW_ROOT = PROJECT_ROOT / "data" / "raw" / "state_case"

# Confirmed first-party CASE feeds, each verified with a live request.
# `courses` maps our internal course key to that state's CFDocument id —
# explicit ids rather than title matching on purpose: every feed carries
# retired frameworks whose titles differ from the live one by a single word
# ("Mathematics - Georgia Standards of Excellence - Retired"), and guessing
# wrong there silently ingests a superseded course of study.
# Use --discover to list a state's documents when adding one.
STATE_FEEDS: dict[str, dict] = {
    "GA": {
        "base": "https://case.georgiastandards.org",
        "version": "v1p1",
        "label": "Georgia Department of Education",
        "courses": {
            "ELA": "391c3abe-c1ec-4a4a-a942-c9e152b35102",
            "Math": "e9dd7229-3558-4df2-85c6-57b8938f6180",
            "Science": "27a08dc6-416e-11e7-ba71-02bd89fdd987",
            "Social_Studies": "a446e74c-463e-11e7-94f5-b49cee8b2d8c",
        },
    },
    "FL": {
        "base": "https://www.cpalms.org/Public",
        "version": "v1p1",
        "label": "CPALMS — Florida Department of Education",
        "courses": {
            "ELA": "57a98ac7-8878-4212-a321-94b9890bca02",
            "Math": "56a98ac7-8878-4212-a321-94b9890bca02",
            "Science": "1da98ac7-8878-4212-a321-94b9890bca02",
            "Social_Studies": "20a98ac7-8878-4212-a321-94b9890bca02",
            # Florida also publishes Dance/Music/Theatre/Visual Art, World
            # Languages, Health, PE and Computer Science — add them here
            # once the app offers those courses for Florida.
        },
    },
    # Document ids below were chosen from each feed's own `adoptionStatus`,
    # not from the year in the title. Where a state has published a newer
    # revision that is still "Pending Implementation", the currently-taught
    # "Adopted" edition is the one mapped — a teacher plans against what is
    # in their classroom this year, not what takes effect in two. That rule
    # changes the answer for North Carolina ELA (2017 over 2026) and for
    # Minnesota Math and Social Studies (the undated/2011 editions over the
    # 2022/2021 ones), and it matches the call already made for Tennessee
    # Social Studies on the CSP side.
    "SC": {
        "base": "https://standards.ed.sc.gov", "version": "v1p0",
        "label": "South Carolina Department of Education",
        "courses": {
            "ELA": "f73bc681-f953-4c40-aa76-6b1a35648b1d",            # ELA, K-12 (2024)
            "Math": "1312c812-376e-4319-81fe-8fdfde065111",           # Mathematics, K-12 (2025)
            "Science": "392fbedd-7702-4f31-b096-f7083441ea8e",        # Science, K-12 (2021)
            "Social_Studies": "9975325b-a599-4a34-9f5c-dfda9240caae", # Social Studies, K-12 (2019)
        },
    },
    "NC": {
        "base": "https://nc-satchel.commongoodlt.com", "version": "v1p0",
        "label": "North Carolina Department of Public Instruction",
        "courses": {
            # Standard Course of Study, not the Occupational Course of Study
            # (a separate track) and not the Spanish translations.
            "ELA": "c649d674-d7cb-11e8-824f-0242ac160002",            # 2017 — Adopted; the 2026 is Pending Implementation
            "Math": "c649d809-d7cb-11e8-824f-0242ac160002",           # 2017-2019
            "Science": "47e89cb5-3293-47d2-a002-92373efd6b7a",        # 2023
            "Social_Studies": "50a88167-d6f5-41ea-a6c1-ee1ea83b6820", # 2021
        },
    },
    "AZ": {
        # Cloudflare rejects urllib here even with a browser User-Agent;
        # this feed needs its packages fetched through a real browser and
        # dropped into data/raw/state_case/az/ before ingest will run.
        "base": "https://standards.azed.gov", "version": "v1p0",
        "label": "Arizona Department of Education",
        "courses": {
            "ELA": "c664d506-d7cb-11e8-824f-0242ac160002",            # 2016
            "Math": "c6498415-d7cb-11e8-824f-0242ac160002",           # 2016
            "Science": "8bbfb0aa-1273-4bf4-8217-31bffd0107b4",        # 2018
            "Social_Studies": "d1d59aa0-f509-4516-a836-74e2085cf0f0", # History and Social Science (2018)
        },
    },
    "WI": {
        "base": "https://wisestandards.dpi.wi.gov", "version": "v1p0",
        "label": "Wisconsin Department of Public Instruction",
        "courses": {
            "ELA": "1adaac54-1b08-4e9c-ac44-57a55707827d",
            "Math": "6bab37e8-30b5-4079-8cc5-4d0be1dce66e",
            "Science": "093f9f92-c3bf-4336-808a-6104d031ec74",        # not "Family and Consumer Science"
            "Social_Studies": "3455e53c-c691-4ddc-8528-cb82b3f3c987",
        },
    },
    "KY": {
        "base": "https://ky.satchelcommons.com", "version": "v1p0",
        "label": "Kentucky Department of Education",
        "courses": {
            "ELA": "5583fec3-c4a5-46e7-b8f2-ce38a58c928c",            # Kentucky calls ELA "Reading and Writing" (2025)
            "Math": "15efb3f5-eb8f-11e9-9f9f-0242ac140002",           # 2019
            "Science": "9594038a-093b-11ee-9abb-0242c0a82003",        # 2022
            "Social_Studies": "51ab2ae2-688d-11ea-911c-0242c0a83003", # 2022
        },
    },
    "OK": {
        "base": "https://ok-satchel.commongoodlt.com", "version": "v1p0",
        "label": "Oklahoma State Department of Education",
        "courses": {
            "ELA": "a45da16c-1268-11ec-a5a7-0242ac1a0003",            # 2021
            "Math": "18f39bc2-ca90-11ed-998f-0242ac160003",           # 2022
            "Science": "ccd9c4c1-5979-4e28-9bb6-8fa4d834f9e0",        # 2020 Adopted; the 2026 is Pending Implementation
            "Social_Studies": "dd27a125-2d86-417d-9ade-0e15e621719b", # 2019
        },
    },
    "MT": {
        "base": "https://mt.satchelcommons.com", "version": "v1p0",
        "label": "Montana Office of Public Instruction",
        "courses": {
            "ELA": "c648c5d7-d7cb-11e8-824f-0242ac160002",
            "Math": "c648ca60-d7cb-11e8-824f-0242ac160002",
            "Science": "4b2018e0-d61b-11e9-a4e7-0242c0a82003",
            "Social_Studies": "392f064e-22d4-11eb-938e-0242c0a85003", # 2021, not the REPEALED edition
        },
    },
    "MN": {
        "base": "https://mn-satchel.commongoodlt.com", "version": "v1p0",
        "label": "Minnesota Department of Education",
        "courses": {
            "ELA": "274b4dcc-6566-4d62-9d3a-d2c150ad070b",            # 2020 — Adopted
            "Math": "c63aa11e-d7cb-11e8-824f-0242ac160002",           # Adopted; the 2022 is Pending Implementation
            "Science": "ee0bb47c-66b9-4d16-bd24-a7343e2337bd",
            "Social_Studies": "9d6c7c98-276f-4dfc-8f58-306cea5bf365", # 2011 Adopted; the 2021 is Pending Implementation
        },
    },
    "ID": {
        "base": "https://nest.edu.idaho.gov", "version": "v1p0",
        "label": "Idaho State Department of Education",
        "courses": {
            "ELA": "45f2d312-329c-4fdc-9310-f7a48224d739",
            "Math": "b0cbf115-1e03-4d51-b96b-7af902d9a229",           # 2022
            "Science": "56dbd92c-0e7c-472a-90a9-e7ceecd14612",        # 2022
            "Social_Studies": "0eaaff5d-e676-40f6-b032-90f1d2dea06c", # 2026
        },
    },
    "AK": {
        "base": "https://ak.satchelcommons.com", "version": "v1p0",
        "label": "Alaska Department of Education",
        "courses": {
            # Titled "- with WIDA Correspondences": these are Alaska's own
            # standards carrying an added mapping to WIDA, not WIDA's.
            "ELA": "c64930d4-d7cb-11e8-824f-0242ac160002",            # 2012
            "Math": "c649e0a2-d7cb-11e8-824f-0242ac160002",           # 2012
            "Science": "ef5da714-d5ba-4db0-aa64-cdf126327c52",        # 2019
            "Social_Studies": "e9e3676e-bc7c-4a3e-a6f3-49a38899dd59", # 2024
        },
    },
    "VA": {
        "base": "https://va.satchelcommons.com", "version": "v1p0",
        "label": "Virginia Department of Education",
        "courses": {
            "ELA": "06f770cb-67f7-4a1a-9c70-5e9f6510e5b7",            # Virginia calls it "English" SOL (2024)
            "Math": "c1ae0acd-cf15-429a-ae61-afc0a1a2480a",           # 2023
            "Science": "f228b6ac-1313-11eb-80c4-0242c0a84003",        # 2018
            "Social_Studies": "e8dde36f-6397-4e02-b644-e356ef4c6223", # "History and Social Science" SOL (2023)
        },
    },
    "DE": {
        "base": "https://de.satchelcommons.com", "version": "v1p0",
        "label": "Delaware Department of Education",
        "courses": {
            "ELA": "c6488303-d7cb-11e8-824f-0242ac160002",            # 2010
            "Math": "c648867e-d7cb-11e8-824f-0242ac160002",
            "Science": "111fce86-80e4-444e-ba51-a67539ad71a7",        # Delaware NGSS
            "Social_Studies": "1ef85993-43ad-4d59-9e85-402580c6eb3c",
        },
    },
    "ND": {
        # Only two of the four core subjects are in this feed at all, and
        # both are dated 2020 — the rest of its 100+ documents are CTE and
        # third-party certifications. Gate the freshness before preferring
        # these over CSP.
        "base": "https://case.nd.gov", "version": "v1p0",
        "label": "North Dakota Department of Public Instruction",
        "courses": {
            "Science": "dad9ab80-cc25-11ea-9c1f-0242c0a84003",
            "Social_Studies": "e3cc2a48-bfc2-11ea-8eed-0242c0a84003",
        },
    },
    "TX": {
        # The TEKS feed answers, but most of it was last touched in
        # 2019-2021. Mapped so it can be compared against CSP per subject;
        # do not activate without that comparison. Also note this feed
        # returns a bare JSON array rather than {"CFDocuments": [...]}.
        "base": "https://teks.texasgateway.org", "version": "v1p0",
        "label": "Texas Education Agency",
        "courses": {
            "ELA": "c22d9405-c1f7-51e6-9883-b3c807e67e6c",            # Chapter 110
            "Math": "bc997e24-7f3b-5df0-a0cd-3a8ac9cf0e2e",           # Chapter 111
            "Science": "2ccca18f-b9cf-5710-8e66-13be2b1b71ba",        # Chapter 112
            "Social_Studies": "a5db260d-f0b9-5315-9adb-6b41f7e18947", # Chapter 113
        },
    },
}

# An item is a citable standard if its type says so. Anything else (Strand,
# Cluster, Domain, Grade Band, Course) is scaffolding that groups standards
# rather than something a lesson plan can cite.
LEAF_TYPES = {"Standard", "Expectation", "Content Standard", "Element", "Benchmark", "Indicator"}
CONTAINER_TYPES = {"Course", "Grade Level", "Grade Band"}

GRADE_MAP: dict[str, int] = {
    "PK": -1, "PRE-K": -1, "P": -1,
    "K": 0, "KG": 0, "00": 0,
    **{f"{i:02d}": i for i in range(1, 13)},
    **{str(i): i for i in range(1, 13)},
}


def fetch_json(url: str) -> object:
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5)
                continue
            print(f"HTTP {e.code} for {url}", file=sys.stderr)
            raise
        except Exception as e:  # noqa: BLE001 — transient network, retry
            print(f"  retry {attempt + 1} for {url}: {e}", file=sys.stderr)
            time.sleep(3)
    raise RuntimeError(f"failed to fetch {url}")


def item_type(item: dict) -> str:
    """The CASE spec's item type, wherever this particular state puts it."""
    return (
        item.get("CFItemType")
        or item.get("Type")
        or (item.get("CFItemTypeURI") or {}).get("title")
        or ""
    )


def clean_statement(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\*\*", "", text or "")).strip()


def grade_from_levels(levels: list[str] | None) -> int:
    """A single grade when the item names exactly one, else 99.

    99 is the same "spans many grades / course-level" sentinel the CSP path
    uses, which /api/frameworks already knows to exclude from a grade picker.
    """
    if not levels:
        return 99
    mapped = {GRADE_MAP.get(str(lv).upper()) for lv in levels}
    if len(mapped) == 1 and None not in mapped:
        grade = next(iter(mapped))
        return grade if grade >= 0 else 99
    return 99


def discover(state: str) -> int:
    feed = STATE_FEEDS[state]
    url = f"{feed['base']}/ims/case/{feed['version']}/CFDocuments"
    print(f"{state}: {url}\n")
    payload = fetch_json(url)
    docs = payload.get("CFDocuments", []) if isinstance(payload, dict) else payload
    print(f"{len(docs)} documents\n")
    for doc in docs:
        pkg = (doc.get("CFPackageURI") or {}).get("identifier") or doc.get("identifier")
        title = doc.get("title") or ""
        creator = doc.get("creator") or ""
        updated = (doc.get("lastChangeDateTime") or "")[:10]
        print(f"  doc={doc.get('identifier')}\n    pkg={pkg}\n    {title[:80]}\n    creator={creator[:50]} updated={updated}\n")
    return 0


def ingest_course(state: str, course: str, doc_id: str, feed: dict, now: str) -> list[dict]:
    raw_dir = RAW_ROOT / state.lower()
    raw_dir.mkdir(parents=True, exist_ok=True)
    cache_path = raw_dir / f"{course.lower()}.json"

    if cache_path.exists():
        print(f"  {course}: cached {cache_path.name}")
        package = json.loads(cache_path.read_text())
    else:
        # The package id is not always the document id — Florida's
        # CFPackageURI points at a different guid, and fetching the document
        # id there 404s. Resolve through the document listing first.
        docs_payload = fetch_json(f"{feed['base']}/ims/case/{feed['version']}/CFDocuments")
        docs = docs_payload.get("CFDocuments", []) if isinstance(docs_payload, dict) else docs_payload
        doc = next((d for d in docs if d.get("identifier") == doc_id), None)
        if doc is None:
            print(f"  {course}: document {doc_id} not in this feed — skipping", file=sys.stderr)
            return []
        pkg_id = (doc.get("CFPackageURI") or {}).get("identifier") or doc_id
        print(f"  {course}: fetching package {pkg_id}...")
        package = fetch_json(f"{feed['base']}/ims/case/{feed['version']}/CFPackages/{pkg_id}")
        cache_path.write_text(json.dumps(package))

    items = {it["identifier"]: it for it in package.get("CFItems", [])}
    parent_of: dict[str, str] = {}
    for assoc in package.get("CFAssociations", []):
        if assoc.get("associationType") == "isChildOf":
            parent_of[assoc["originNodeURI"]["identifier"]] = assoc["destinationNodeURI"]["identifier"]

    doc_title = (package.get("CFDocument") or {}).get("title") or feed["label"]

    def nearest_container(item_id: str, depth: int = 0) -> dict | None:
        if depth > 15 or item_id not in parent_of:
            return None
        parent = items.get(parent_of[item_id])
        if parent and item_type(parent) in CONTAINER_TYPES:
            return parent
        return nearest_container(parent_of[item_id], depth + 1)

    # Some feeds type every item; some type none of them. Where nothing is
    # typed as a leaf, fall back to "has a code and reads like a sentence" —
    # the same test scripts/01d_ingest_alcos_case.py uses for Alabama.
    typed_leaves = any(item_type(it) in LEAF_TYPES for it in items.values())

    chunks: list[dict] = []
    seen: set[tuple] = set()
    for item_id, item in items.items():
        code = item.get("humanCodingScheme")
        description = clean_statement(item.get("fullStatement", ""))
        if not code or not description:
            continue
        if typed_leaves:
            if item_type(item) not in LEAF_TYPES:
                continue
        elif len(description) < 25 or len(description.split()) < 4:
            continue

        grade = grade_from_levels(item.get("educationLevel"))
        container = nearest_container(item_id)
        section = clean_statement(container.get("fullStatement", "")) if container else doc_title

        parent_id = parent_of.get(item_id)
        parent = items.get(parent_id) if parent_id else None
        parent_code = parent.get("humanCodingScheme") if parent else None
        parent_text = clean_statement(parent.get("fullStatement", "")) if parent else None

        key = (grade, code, description)
        if key in seen:
            continue
        seen.add(key)

        chunks.append({
            "code": code,
            "description": description,
            "course": course,
            "grade": grade,
            "state": state,
            "source_type": "state_course_of_study",
            "source_document": doc_title,
            "source_page_or_section": section,
            "strand": None,
            "parent_code": parent_code,
            "parent_text": parent_text,
            "notes": [],
            "embed_text": f"[{code}] {description}" + (f" (Under: {parent_text})" if parent_text else ""),
            "verbatim_ok": True,  # straight from the state's own feed, no paraphrase
            "official_source_url": f"{feed['base']}/ims/case/{feed['version']}/CFDocuments/{doc_id}",
            "case_item_uri": item.get("uri"),
            "source_case_id": doc_id,
            "source_ingested_at": now,
            "csp_subject": None,
            "csp_standard_set_id": None,
        })
    return chunks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", help="postal code, e.g. FL")
    parser.add_argument("--discover", metavar="STATE", help="list a state's CFDocuments and exit")
    parser.add_argument("--only", nargs="*", metavar="COURSE")
    args = parser.parse_args()

    target = (args.discover or args.state or "").upper()
    if not target:
        parser.error("pass --state or --discover")
    if target not in STATE_FEEDS:
        parser.error(f"{target} has no known first-party CASE feed. Known: {', '.join(sorted(STATE_FEEDS))}")

    if args.discover:
        return discover(target)

    feed = STATE_FEEDS[target]
    courses = feed["courses"]
    if not courses:
        print(f"{target} has a feed but no per-course document mapping yet.")
        print(f"Run: python scripts/01h_ingest_state_case.py --discover {target}")
        return 1
    if args.only:
        courses = {c: d for c, d in courses.items() if c in set(args.only)}

    now = datetime.now(UTC).isoformat()
    print(f"{target} — {feed['label']}")
    for course, doc_id in courses.items():
        chunks = ingest_course(target, course, doc_id, feed, now)
        if not chunks:
            continue
        out_path = OUT_DIR / f"{target.lower()}_{course.lower()}_csp_chunks.json"
        out_path.write_text(json.dumps(chunks, indent=2))
        graded = sum(1 for c in chunks if c["grade"] != 99)
        print(f"    {len(chunks)} standards ({graded} grade-specific) -> {out_path.name}")

    print(f"\nDone. Verify with: python scripts/ingest_gate.py --state {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
