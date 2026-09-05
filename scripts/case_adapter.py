#!/usr/bin/env python3
"""The shared CASE 1.0 adapter: any state's standards -> the chunk schema.

Moved here verbatim from 01d_ingest_alcos_case.py, which is now a thin Alabama
entry point over this module. Only four things were state-coupled and they are
now arguments rather than module constants: the CASE server, the package cache
directory, the PDF directory, and the state code written into every chunk.

Everything else was already state-agnostic, which is the useful finding: the
STRUCTURAL_TYPES/STRAND_TYPES vocabularies, the graph-shape rules that tell a
container from a standard, the grade mapping and the PDF verification are
properties of the CASE specification and of poppler, not of Alabama. The skill's
rule — "Do not copy the Alabama parser into a new state and edit it until it
happens to work" — is satisfied by sharing this, not by forking it.

WHY THERE IS NO LLM IN HERE, still: the standard text comes from the state's own
CASE feed, and the published PDF is the verification target rather than the
input. That is what avoids paraphrase risk across thousands of standards, and it
is a property of this file that should not be traded away for a state that only
publishes PDFs — see the manifest's `unmapped` for the alternative.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import subprocess
import sys
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Packages are cached per state, so two states' CFPackage ids can never collide
# in one flat directory and a refresh of one state cannot invalidate another.
CASE_CACHE_ROOT = PROJECT_ROOT / "data" / "raw" / "case"

log = logging.getLogger("case_adapter")

# CFItemTypes whose fullStatement is USUALLY a label ("Grade 8", "Geometry")
# rather than a standard.
#
# "Usually" is load-bearing. Type names are overloaded across subjects and cannot
# be trusted on their own: PE and World Languages put real statement text under
# "Component", Arts Education uses both "Sub-standard" and "Substandard", and the
# School Counseling package types its twelve domain *labels* AND all ~190 of its
# actual standards as "Domain". An earlier version of this script treated Domain
# as structural and silently produced zero chunks for that entire subject.
#
# So the type list only decides what is a *candidate* for being scaffolding. The
# structure of the graph decides the rest — see the two guards below:
#   * a candidate WITH children is a container (the Domain labels, "Grade 8")
#   * a candidate that is a leaf is kept only if it reads like a sentence
STRUCTURAL_TYPES = {
    "Grade", "Grade Level", "Level", "Course", "Discipline",
    "Content Area", "Content Subarea", "Category", "Focus Area",
    "Cluster", "Essential Concept", "Topic", "Strand", "Domain",
    "Disciplinary Core Idea", "Anchor Standard", "Artistic Process",
    "Process Component", "Conceptual Theme", "Concept Thread",
    "Content Identifier",
}

# Ancestor types that make a good `strand` label, best first.
STRAND_TYPES = (
    "Content Area", "Discipline", "Strand", "Domain", "Topic",
    "Disciplinary Core Idea", "Conceptual Theme", "Anchor Standard",
    "Artistic Process", "Category", "Cluster", "Content Subarea",
    "Focus Area", "Concept Thread", "Essential Concept",
)


def normalize(text: str) -> str:
    """Same normalizer the other parsers use, so verbatim checks are comparable.

    Two additions specific to the CASE feed. Both apply to the PDF side too, so
    the comparison stays symmetric:

    * Markdown emphasis. Many statements arrive marked up — Physical Education's
      APE recommendations look like ``___APE accommodation suggestions:__
      Sliding, galloping...``. None of that is in the PDF. Left in, it failed
      every APE row and held PE's verbatim rate down at 35%.
    * Hyphenation at line breaks, which Poppler and the feed disagree about:
      Poppler emits "curl- ing" where the feed says "curling".
    """
    text = unicodedata.normalize("NFKC", text)
    text = "".join(c for c in text if unicodedata.category(c)[0] != "C" or c.isspace())
    for a, b in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"),
                 ("–", "-"), ("—", "-"), (" ", " ")):
        text = text.replace(a, b)
    text = _MARKUP_RE.sub(" ", text)
    text = re.sub(r"-\s+", "-", text)
    return re.sub(r"\s+", " ", text).strip()


# Markdown emphasis / list residue present in CASE fullStatement values but never
# in the rendered PDF.
_MARKUP_RE = re.compile(r"[_*`]+")

_NONWORD_RE = re.compile(r"[^0-9a-z ]+")


def wordwise(text: str) -> str:
    """normalize(), then drop punctuation entirely and lowercase.

    This answers the question that actually matters — "are these the same words in
    the same order?" — separately from "are these the same bytes?".

    The strict check fails on things that are not text changes at all: the feed
    writes ``less/fewer than ,`` with a space before the comma where the PDF has
    none, and Poppler reflows table cells. Reporting only the strict rate would
    imply ~48% of the PE standards are untrustworthy, when in fact their wording
    is identical and the punctuation differs by a space.
    """
    return re.sub(r"\s+", " ", _NONWORD_RE.sub(" ", normalize(text).lower())).strip()


def parse_grades(spec: str) -> frozenset[int]:
    """'9-12' | '0-12' | '11' | '9,10,11' -> the set of grades to keep (0 = K)."""
    out: set[int] = set()
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _, hi = part.partition("-")
            try:
                lo_i, hi_i = int(lo), int(hi)
            except ValueError:
                raise ValueError(f"--grades: {part!r} is not a range like 9-12") from None
            if lo_i > hi_i:
                raise ValueError(f"--grades: {part!r} is backwards")
            out.update(range(lo_i, hi_i + 1))
        else:
            try:
                out.add(int(part))
            except ValueError:
                raise ValueError(f"--grades: {part!r} is not a grade number") from None
    bad = sorted(g for g in out if not 0 <= g <= 12)
    if bad:
        raise ValueError(f"--grades: {bad} outside 0-12 (0 = Kindergarten)")
    if not out:
        raise ValueError("--grades: no grades selected")
    return frozenset(out)


def sentence_like(statement: str) -> bool:
    """Does this read as a standard rather than a heading?

    Used only to disambiguate leaves of overloaded CFItemTypes. "Academic
    Development" and "Geometry" are headings; "Describe the rights and
    responsibilities of individuals in the workplace..." is a standard.
    """
    s = statement.strip()
    return len(s) >= 25 and len(s.split()) >= 4


def grade_from_level(level: str) -> int | None:
    """CASE educationLevel -> the int the app filters on. None if not a K-12 grade."""
    level = level.strip().upper()
    if level in ("KG", "K", "PK"):
        return 0
    if level.isdigit():
        g = int(level)
        return g if 0 <= g <= 12 else None
    return None


def _render_table(rows: list[list[str | None]]) -> str:
    """One pdfplumber table -> plain text, ' | '-separated per cell — see
    pdftotext()'s own docstring for why a table has to be rendered this way
    at all."""
    lines = []
    for row in rows:
        cells = [re.sub(r"\s+", " ", (c or "")).strip() for c in row]
        if any(cells):
            lines.append(" | ".join(cells))
    return "\n".join(lines)


def _page_text(page) -> str:
    tables = page.find_tables()
    if not tables:
        return page.extract_text() or ""
    try:
        non_table = page
        for t in tables:
            non_table = non_table.outside_bbox(t.bbox)
        prose = non_table.extract_text() or ""
    except ValueError:
        # A detected table's bbox can extend past the page edge (seen on a
        # decorative callout box misread as a table) — outside_bbox() raises
        # on that rather than clamping. Falling back to the whole page's
        # plain text loses nothing real: a misdetected "table" was never
        # going to render usefully as one anyway.
        prose = page.extract_text() or ""
    parts = [prose] if prose.strip() else []
    for t in tables:
        try:
            parts.append(_render_table(t.extract()))
        except ValueError:
            continue
    return "\n\n".join(parts)


def pdftotext(pdf: Path) -> str:
    """pdfplumber's table detection, not plain pdftotext -enc UTF-8.

    Found live, diagnosing PE's 51% verbatim rate (Feb 2026): PE's standards
    are full of multi-column bulleted lists — "Demonstrate kicking skills
    by: [col A] ... [col B] ..." — that a plain linear text extractor reads
    left-to-right ACROSS the whole page width, fusing unrelated bullets from
    different columns onto one line ("...and • Using a running kick it
    forward. approach towards a stationary ball..." — two different bullets,
    two different columns, one garbled sentence). The CASE feed's statement
    was correct the whole time; the plain-text baseline this function used
    to build had already scrambled the very words being checked against it
    — the same false-rejection bug the Pre-AP arts courses had, just via
    bulleted columns instead of a proficiency-level table. pdfplumber's
    table detection finds the real column boundaries, so a bullet from
    column A is never spliced onto column B's bullet regardless of how many
    columns share a row.

    A genuine wording difference between the CASE feed and a newer PDF
    revision (this function's own module docstring gives a real example)
    still correctly fails after this change — this fixes an extraction
    artifact, not the standard of comparison.
    """
    if not pdf.is_file():
        log.warning("  PDF not found, verbatim check skipped: %s", pdf.name)
        return ""
    try:
        import pdfplumber

        with pdfplumber.open(pdf) as doc:
            text = "\n\n".join(_page_text(p) for p in doc.pages)
        return normalize(text)
    except Exception as exc:
        log.warning("  pdfplumber failed on %s: %s", pdf.name, exc)
        return ""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_fingerprint(pkg: dict) -> str:
    """Fingerprint CASE content without depending on JSON key ordering."""
    payload = json.dumps(pkg, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return sha256_bytes(payload)


def fetch_package(case_id: str, refresh: bool = False, *,
                  case_api: str, state_code: str) -> dict:
    """One CASE package, from the cache when we already have it.

    `case_api` is the state's own CASE server, and the cache is per state: the
    packages are the ingest's raw input, and an ingest that silently read
    another state's cached package would be undetectable afterwards.
    """
    cache = CASE_CACHE_ROOT / state_code.upper()
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"{case_id}.json"
    if refresh or not path.is_file():
        url = f"{case_api.rstrip('/')}/CFPackages/{case_id}"
        log.info("  downloading %s", url)
        with urllib.request.urlopen(url, timeout=120) as resp:
            path.write_bytes(resp.read())
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_tree(pkg: dict) -> tuple[dict, dict, set]:
    """items by id, child->parent map, and the set of ids that have children."""
    items = {i["identifier"]: i for i in pkg.get("CFItems", [])}
    parent_of: dict[str, str] = {}
    has_children: set[str] = set()
    for assoc in pkg.get("CFAssociations", []):
        if assoc.get("associationType") != "isChildOf":
            continue
        child = (assoc.get("originNodeURI") or {}).get("identifier")
        parent = (assoc.get("destinationNodeURI") or {}).get("identifier")
        if not child or not parent:
            continue
        parent_of[child] = parent
        has_children.add(parent)
    return items, parent_of, has_children


def ancestors(item_id: str, items: dict, parent_of: dict) -> list[dict]:
    """Nearest-first ancestor chain, cycle-safe."""
    out, seen, cur = [], {item_id}, parent_of.get(item_id)
    while cur and cur not in seen and cur in items:
        seen.add(cur)
        out.append(items[cur])
        cur = parent_of.get(cur)
    return out


def pick_strand(chain: list[dict]) -> str | None:
    """The most descriptive structural ancestor, preferring broad topical types."""
    for want in STRAND_TYPES:
        for anc in reversed(chain):  # outermost match wins: subject area, not sub-bullet
            if anc.get("CFItemType") == want:
                label = (anc.get("fullStatement") or "").strip()
                if label and len(label) <= 160:
                    return label
    return None


def ingest_framework(course: str, case_id: str, pdf_name: str, *,
                     refresh: bool, strict: bool,
                     keep_grades: frozenset[int],
                     state_code: str, pdf_dir: Path,
                     case_api: str) -> tuple[list[dict], dict]:
    pkg = fetch_package(case_id, refresh=refresh, case_api=case_api, state_code=state_code)
    doc = pkg.get("CFDocument", {})
    title = doc.get("title", course)
    log.info("%s — %s", course, title)

    pdf_path = pdf_dir / pdf_name
    pdf_sha256 = sha256_bytes(pdf_path.read_bytes()) if pdf_path.is_file() else None
    package_sha256 = source_fingerprint(pkg)
    source_version = (
        doc.get("lastChangeDateTime")
        or doc.get("statusStartDate")
        or doc.get("identifier")
        or "unknown"
    )
    ingested_at = datetime.now(UTC).isoformat(timespec="seconds")

    items, parent_of, has_children = build_tree(pkg)
    pdf_text = pdftotext(pdf_path)
    pdf_words = wordwise(pdf_text) if pdf_text else ""

    chunks: list[dict] = []
    stats = Counter()
    per_grade = defaultdict(int)

    for item_id, item in items.items():
        itype = (item.get("CFItemType") or "").strip()
        statement = (item.get("fullStatement") or "").strip()
        if not statement:
            stats["skipped_no_statement"] += 1
            continue
        # Scaffolding candidates are resolved by graph shape, not by type name.
        if itype in STRUCTURAL_TYPES:
            if item_id in has_children:
                # A container: "Grade 8", or School Counseling's "Academic
                # Development" sitting above its standards. Context only.
                stats["skipped_structural"] += 1
                continue
            if not sentence_like(statement):
                # A leaf label with no standards under it — nothing to cite.
                stats["skipped_label_leaf"] += 1
                continue
            # A leaf of a scaffolding-ish type that reads like a real statement:
            # this is the School Counseling case. Keep it.
            stats["kept_overloaded_type"] += 1
        # A non-structural node with children is an intermediate standard whose
        # children restate it; keep it, since it is the level a lesson plan cites.
        chain = ancestors(item_id, items, parent_of)
        code = (item.get("humanCodingScheme") or "").strip()
        if not code:
            # Without a citable code the chunk can't be audited by
            # retrieval.audit_grounding, so it is worthless for this app.
            stats["skipped_no_code"] += 1
            continue

        # Grade scope is resolved BEFORE the verbatim check so the reported rates
        # describe the standards actually stored, not the whole K-12 package.
        levels = item.get("educationLevel") or []
        grades = sorted({g for g in (grade_from_level(l) for l in levels) if g is not None})
        if not grades:
            # Inherit from the nearest ancestor that names grades, so items that
            # omit educationLevel still land in a grade the UI can select. No
            # 99 sentinel: the app filters grade == int, so 99 is unreachable.
            for anc in chain:
                inherited = sorted(
                    {g for g in (grade_from_level(l) for l in (anc.get("educationLevel") or []))
                     if g is not None}
                )
                if inherited:
                    grades = inherited
                    stats["grade_inherited"] += 1
                    break
        if not grades:
            stats["skipped_no_grade"] += 1
            continue

        # Grade scope. Applied here rather than at query time so the store, the
        # Standards browser and the Grade Level dropdown all agree on what exists
        # — a K-8 standard that can never be selected is just weight.
        in_scope = [g for g in grades if g in keep_grades]
        if not in_scope:
            stats["skipped_out_of_grade_scope"] += 1
            continue
        grades = in_scope

        verbatim = bool(pdf_text) and normalize(statement) in pdf_text
        # Same words, same order, punctuation ignored. A statement that passes
        # this but fails the strict check differs from the PDF by spacing or
        # punctuation only — its wording is intact.
        word_ok = verbatim or (bool(pdf_words) and wordwise(statement) in pdf_words)
        stats["verbatim_ok" if verbatim else "verbatim_miss"] += 1
        stats["wordwise_ok" if word_ok else "wordwise_miss"] += 1
        # --strict drops anything whose *wording* can't be found in the PDF. It
        # does not drop punctuation-only differences, which are extraction noise.
        if strict and not word_ok and pdf_words:
            stats["dropped_strict"] += 1
            continue

        strand = pick_strand(chain)
        parent = chain[0] if chain else None
        parent_code = (parent or {}).get("humanCodingScheme") or None
        parent_text = ((parent or {}).get("fullStatement") or "").strip() or None
        # A parent that is just a grade label adds nothing to the embedding.
        if parent_text and (parent or {}).get("CFItemType") in ("Grade", "Grade Level"):
            parent_text = None

        section = " > ".join(
            (a.get("fullStatement") or "").strip() for a in reversed(chain)
            if (a.get("fullStatement") or "").strip()
        )[:300] or title

        # One chunk per grade. A standard tagged 9-12 must be findable when the
        # teacher has grade 11 selected, and Chroma's `grade == 11` filter can't
        # match a list. Cheap: these are ~8k rows, not millions.
        for grade in grades:
            chunks.append({
                "code": code,
                "description": statement,
                "course": course,
                "grade": grade,
                "state": state_code,
                "source_type": "state_course_of_study",
                "source_document": pdf_name.split("/")[-1],
                "source_page_or_section": section,
                "strand": strand,
                "mode": None,
                "domain": None,
                "sub_skill": None,
                "score_band": None,
                "reporting_category": None,
                "frequency": None,
                "examples": None,
                "parent_code": parent_code,
                "parent_text": parent_text,
                "notes": [] if verbatim else [
                    ("Wording matches the PDF but punctuation/spacing differs "
                     "(PDF extraction artifact)." if word_ok else
                     "Not found in the local PDF's extracted text, even ignoring "
                     "punctuation. Source is the ALSDE CASE package (no LLM in the "
                     "extraction path); usually a reflowed table cell or a PDF "
                     "revision newer than the CASE package.")
                ],
                "item_type": itype,
                "case_framework": title,
                "case_item_uri": item.get("uri"),
                "source_case_id": case_id,
                "source_version": source_version,
                "source_package_sha256": package_sha256,
                "source_pdf_sha256": pdf_sha256,
                "source_ingested_at": ingested_at,
                "official_source_url": doc.get("officialSourceURL"),
                "verbatim_ok": verbatim,
                "wordwise_ok": word_ok,
                "embed_text": _embed_text(course, title, strand, code, statement, parent_text, grade),
            })
            per_grade[grade] += 1

    # Report metrics are based on emitted source standards, not parser attempts.
    # In strict mode some attempts are deliberately dropped, and counting them
    # would make the report disagree with the file that is about to be embedded.
    unique_emitted: dict[tuple[str, str], dict] = {}
    for chunk in chunks:
        unique_emitted.setdefault((chunk["code"], chunk["description"]), chunk)
    total_checked = len(unique_emitted)
    emitted_verbatim = sum(bool(c.get("verbatim_ok")) for c in unique_emitted.values())
    emitted_wordwise = sum(bool(c.get("wordwise_ok")) for c in unique_emitted.values())
    rate = (emitted_verbatim / total_checked * 100) if total_checked else 0.0
    word_rate = (emitted_wordwise / total_checked * 100) if total_checked else 0.0
    log.info(
        "  %d standards -> %d chunks | verbatim %.1f%% | wording %.1f%% (%d/%d) | grades %s",
        total_checked, len(chunks),
        rate, word_rate, stats["wordwise_ok"], total_checked,
        ",".join(str(g) for g in sorted(per_grade)) or "-",
    )
    for key in ("skipped_no_code", "skipped_no_grade", "grade_inherited",
                "dropped_strict", "kept_overloaded_type", "wordwise_miss"):
        if stats[key]:
            log.info("    %s: %d", key, stats[key])

    return chunks, {
        "course": course, "framework": title, "chunks": len(chunks),
        "standards": total_checked,
        "verbatim_ok": emitted_verbatim, "verbatim_rate": round(rate, 1),
        "wordwise_ok": emitted_wordwise, "wordwise_rate": round(word_rate, 1),
        "unmatched": total_checked - emitted_wordwise,
        "pdf": pdf_name,
        "pdf_text_available": bool(pdf_text),
        "official_source_url": doc.get("officialSourceURL"),
        "source_case_id": case_id,
        "source_version": source_version,
        "source_package_sha256": package_sha256,
        "source_pdf_sha256": pdf_sha256,
        "source_ingested_at": ingested_at,
        "grades": sorted(per_grade),
        "grade_scope": sorted(keep_grades),
        "skipped_out_of_grade_scope": stats["skipped_out_of_grade_scope"],
    }


def _embed_text(course, framework, strand, code, statement, parent_text, grade) -> str:
    """What actually gets embedded.

    Grade goes in the text, not just the metadata filter: KNOWN_GAPS.md is
    explicit that grade must be part of a chunk's identity because every grade
    re-uses the same standard numbers. Strand and parent give the abstract
    statement enough context to be reachable from a teacher's phrasing.
    """
    head = f"{framework} — Grade {'K' if grade == 0 else grade}"
    if strand:
        head += f" — {strand}"
    body = f"[{code}] {statement}"
    if parent_text and parent_text != statement:
        body += f" (Under: {parent_text})"
    return f"{head}\n{body}"


