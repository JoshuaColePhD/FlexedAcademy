#!/usr/bin/env python3
"""Fetch a state's standards from the Common Standards Project API, driven by
`public.standards_frameworks` (see scripts/manifest_db.py) instead of a
hardcoded subject list.

Generalizes scripts/01_fetch_case_api.py (which is hardcoded to Alabama) to
any state that has manifest rows with source_kind in
('csp_only', 'state_case_feed') and a csp_subject_string set. A row with no
csp_subject_string (CSP doesn't have a current version of that course) is
skipped and left for a direct state PDF/CASE source instead — see that row's
`notes` in the manifest for why.

Usage:
    python scripts/01e_fetch_csp_state.py --state GA
    python scripts/01e_fetch_csp_state.py --state GA --only ELA Math
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
import urllib.error
from collections import defaultdict
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import manifest_db  # noqa: E402
from backend.config import settings  # noqa: E402

log = logging.getLogger("standards.fetch_csp_state")
logging.basicConfig(level=logging.INFO, format="%(message)s")

BASE_URL = "https://api.commonstandardsproject.com/api/v1"
OUTPUT_DIR = PROJECT_ROOT / "data" / "processed"

# CSP's jurisdiction list is keyed by full state name, not postal code (see
# frontend/src/lib/states.js's US_STATES for the canonical postal-code list
# this mirrors on the frontend side).
STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DC": "District of Columbia", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(
        url, headers={"Api-Key": settings.common_standards_api_key, "Accept": "application/json"}
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5)
                continue
            log.error(f"HTTP {e.code} for {url}")
            raise
    raise RuntimeError(f"failed to fetch {url} after retries")


def grades_from_title(title: str) -> list[int]:
    """Return every grade named by a CSP standard-set title.

    CSP uses several equivalent shapes: ``Grade 6``, ``Grades 6-8``,
    ``Grades 6, 7, 8``, ``Grade K``, and occasionally ``Grades K, 1, 2``.
    Alabama's CASE ingest emits a grade-scoped copy for each covered grade;
    doing the same here is important because retrieval filters on the selected
    class grade. Named high-school courses that omit an explicit grade (for
    example ``Algebra I`` or ``American Literature``) are expanded to 9-12;
    genuinely course-wide records remain in the ``99`` bucket.
    """
    t = title.strip()
    lower = t.lower()
    if "pre-k" in lower or "pre k" in lower or "prekindergarten" in lower:
        return [99]  # the application grade domain is K-12
    if "kindergarten" in lower or re.search(r"\bgrade\s+k\b", lower):
        return [0]

    # Keep the title prefix only; years and course numbers later in the title
    # are not grade declarations.
    match = re.search(r"\bgrades?\s+([^:]+)", t, flags=re.IGNORECASE)
    if not match:
        high_school_course = re.search(
            r"\b(?:algebra|geometry|calculus|pre[- ]?calculus|statistics|literature|composition|"
            r"biology|chemistry|physics|earth science|environmental science|government|civics|"
            r"economics|american history|world history|u\.?s\.? history|psychology|sociology|"
            r"anatomy|forensic|astronomy|botany|geology|entomology|epidemiology)\b",
            lower,
        ) or re.search(r"\b(?:ap|pre[- ]?ap)\b", lower)
        return list(range(9, 13)) if high_school_course else [99]
    prefix = match.group(1)
    values = [int(n) for n in re.findall(r"\b\d{1,2}\b", prefix) if 0 <= int(n) <= 12]
    if re.search(r"\bK\b", prefix, flags=re.IGNORECASE):
        values.append(0)
    if not values:
        return [99]
    if re.search(r"\b(\d{1,2})\s*-\s*(\d{1,2})\b", prefix):
        start, end = map(int, re.search(r"\b(\d{1,2})\s*-\s*(\d{1,2})\b", prefix).groups())
        if 0 <= start <= end <= 12:
            return list(range(start, end + 1))
    return sorted(set(values))


def dedup_text(text: str) -> str:
    """Normalize harmless CSP restatements for safe duplicate collapsing."""
    value = re.sub(r"\s+", " ", (text or "").strip().lower())
    value = re.sub(r"^the student will be able to\s+", "", value)
    value = re.sub(r"^the student will\s+", "", value)
    return value.rstrip(":")


def collapse_safe_duplicates(chunks: list[dict]) -> list[dict]:
    """Keep the richer record for boilerplate/prefix restatements.

    Some CSP packages publish both a short parent sentence and a longer
    expanded version under the same code, or add the boilerplate
    ``The student will be able to``. These are safe to collapse when they
    occur in the same grade and same displayed standard-set title. Distinct
    descriptions that are not equivalent remain untouched for the gate to
    audit.
    """
    kept: list[dict] = []
    positions: dict[tuple, list[int]] = defaultdict(list)
    for chunk in chunks:
        key = (chunk["grade"], chunk["code"], chunk["source_page_or_section"])
        current = dedup_text(chunk["description"])
        replaced = False
        for index in positions.get(key, []):
            previous = dedup_text(kept[index]["description"])
            shorter, longer = sorted((previous, current), key=len)
            equivalent = shorter == longer or (
                len(shorter) >= 20 and longer.startswith(shorter)
            )
            if equivalent:
                if len(current) > len(previous):
                    kept[index] = chunk
                replaced = True
                break
        if not replaced:
            positions.setdefault(key, []).append(len(kept))
            kept.append(chunk)
    return kept


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, help="postal code, e.g. GA")
    parser.add_argument("--only", nargs="*", metavar="COURSE", help="limit to these manifest courses")
    args = parser.parse_args()

    if not settings.common_standards_api_key:
        log.error("COMMON_STANDARDS_API_KEY is not set.")
        return 1

    state = args.state.upper()
    rows = manifest_db.get_frameworks(state)
    if args.only:
        rows = [r for r in rows if r["course"] in set(args.only)]
    rows = [r for r in rows if r["source_kind"] in ("csp_only", "state_case_feed") and r.get("csp_subject_string")]
    if not rows:
        log.error(f"No manifest rows for state={state} with a csp_subject_string set.")
        return 1

    log.info("Fetching CSP jurisdiction list...")
    jurisdictions = fetch_json(f"{BASE_URL}/jurisdictions")["data"]
    state_name = STATE_NAMES.get(state)
    jurisdiction = next((j for j in jurisdictions if j["title"] == state_name), None)
    if not jurisdiction:
        log.error(f"Could not find CSP jurisdiction for {state} ({state_name!r}).")
        return 1

    sets_data = fetch_json(f"{BASE_URL}/jurisdictions/{jurisdiction['id']}")["data"]
    all_sets = sets_data.get("standardSets", [])

    for row in rows:
        course = row["course"]
        subject = row["csp_subject_string"]
        # CSP itself has at least one duplicate-with-trailing-space subject
        # string (seen for Georgia's "English Language Arts (2025-)"); match
        # on stripped subject so that data quirk on CSP's side doesn't quietly
        # drop half the standard sets.
        matching_sets = [
            s for s in all_sets
            if (s.get("subject") or "").strip() == subject.strip()
            # "Access Points" sets are a state's parallel alternate-achievement
            # standards for students with significant cognitive disabilities
            # (seen for Florida) — a genuinely different framework that
            # happens to share the same CSP `subject` string and can even
            # reuse the same code numbers as the general standards. That's a
            # real, separate course-of-study, not part of this one; excluded
            # here rather than silently merged in. Revisit as its own course
            # (mirroring how Alabama tracks Special_Education separately) if
            # this ever needs to be ingested.
            and "access points" not in (s.get("title") or "").lower()
            # "Instructional Focus Documents" (seen for Tennessee) are a
            # secondary, elaboration/pacing-guide companion to the primary
            # standard set — same standards re-published with instructional
            # notes, sometimes with formatting-mangled codes (stray
            # non-breaking spaces) that then collide with the primary
            # document's clean codes. Not a new source of standards; skip it
            # so it doesn't shadow the primary set.
            and "instructional focus" not in (s.get("title") or "").lower()
        ]
        if not matching_sets:
            log.warning(f"  {course}: no CSP standard sets found for subject {subject!r} — skipping")
            continue

        log.info(f"{course}: fetching {len(matching_sets)} standard set(s) for {subject!r}")
        chunks = []
        # Some CSP subjects publish the same standard under several
        # standard-set "packagings" of the same course (e.g. Georgia's
        # Algebra appears as a full-year set, a semester-1-only split, and an
        # accelerated-for-grade-8 variant) — same code, same text, genuinely
        # not a new standard. Drop exact repeats within this course rather
        # than shipping literal duplicate rows; a *different* description
        # under the same (grade, code) is a real collision and is left in
        # for the gate to catch.
        seen_exact: set[tuple] = set()
        for sset in matching_sets:
            set_id = sset["id"]
            title = sset["title"]
            try:
                detail = fetch_json(f"{BASE_URL}/standard_sets/{set_id}")
            except Exception as e:
                log.error(f"  FAILED {title} ({set_id}): {e}")
                continue
            standards_dict = detail["data"].get("standards", {})
            grades = grades_from_title(title)

            # CSP's `standards` dict mixes real, citable standards with
            # structural container nodes (domains/strands/unit titles) that
            # have no statementNotation and just label a group of children —
            # e.g. "Modeling and Analyzing Quadratic Functions". Keeping
            # those would pollute the corpus with non-standards. Same
            # distinction scripts/01d_ingest_alcos_case.py draws for Alabama
            # (STRUCTURAL_TYPES + sentence_like), adapted here since CSP
            # doesn't expose an explicit "type" the same way: an item counts
            # as a real standard if it has a statementNotation, OR it's a
            # childless leaf whose description reads like a standard rather
            # than a short topic label (>=25 chars, >=4 words).
            has_children = {st.get("parentId") for st in standards_dict.values() if st.get("parentId")}

            def sentence_like(text: str) -> bool:
                return len(text) >= 25 and len(text.split()) >= 4

            for st_id, st in standards_dict.items():
                code = st.get("statementNotation")
                description = st.get("description") or ""
                if not description.strip():
                    continue
                is_container = st_id in has_children
                if not code and (is_container or not sentence_like(description)):
                    continue  # structural node, not a citable standard

                effective_code = code or f"CSP:{st_id}"
                parent_id = st.get("parentId")
                parent = standards_dict.get(parent_id) if parent_id else None
                parent_text = parent.get("description", "") if parent else ""
                for grade_val in grades:
                    exact_key = (grade_val, effective_code, description)
                    if exact_key in seen_exact:
                        continue
                    seen_exact.add(exact_key)
                    chunks.append({
                        "code": effective_code,
                        "description": description,
                        "course": course,
                        "grade": grade_val,
                        "state": state,
                        "source_type": "csp_api",
                        "source_document": f"CSP_{set_id}",
                        "source_page_or_section": title,
                        "strand": None,
                        "parent_code": parent.get("statementNotation") if parent else None,
                        "parent_text": parent_text,
                        "notes": [] if code else ["CSP did not provide a statementNotation for this item; code is a synthetic CSP item id."],
                        "embed_text": f"[{effective_code}] {description}" + (f" (Under: {parent_text})" if parent_text else ""),
                        "verbatim_ok": None,  # unknown — no independent source cross-checked yet, see ingest_gate.py
                        "case_item_uri": None,
                        "csp_standard_set_id": set_id,
                        "csp_subject": subject,
                        "source_ingested_at": None,  # filled by caller/gate at write time if needed
                    })

        chunks = collapse_safe_duplicates(chunks)

        # A small number of codes are genuinely ambiguous within a single CSP
        # standard-set document itself (same set_id, same code, different
        # text — seen for Tennessee: "TN.8.1" names two unrelated Grade 8
        # standards in the same document). That's a real error in the
        # source, not something ingestion can resolve, and shipping either
        # one under an ambiguous shared code would make citation lookups
        # unreliable. Drop every chunk sharing such a code rather than guess.
        by_doc_code: dict[tuple, set[str]] = defaultdict(set)
        for c in chunks:
            by_doc_code[(c["grade"], c["csp_standard_set_id"], c["code"])].add(c["description"])
        ambiguous = {k for k, descs in by_doc_code.items() if len(descs) > 1}
        if ambiguous:
            for grade, set_id, code in ambiguous:
                log.warning(f"  dropping ambiguous code {code!r} (grade {grade}, set {set_id}) — same document assigns it >1 meaning")
            chunks = [c for c in chunks if (c["grade"], c["csp_standard_set_id"], c["code"]) not in ambiguous]

        out_path = OUTPUT_DIR / f"{state.lower()}_{course.lower()}_csp_chunks.json"
        out_path.write_text(json.dumps(chunks, indent=2))
        log.info(f"  wrote {len(chunks)} chunks -> {out_path}")
        manifest_db.update_framework(state, course, status="staged", last_chunk_count=len(chunks))

    log.info("Done. Run scripts/ingest_gate.py to verify before activating.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
