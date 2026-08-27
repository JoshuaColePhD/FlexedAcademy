#!/usr/bin/env python3
"""
Step 1d — Ingest every Alabama Course of Study subject into the chunk schema.

Why this exists, and why it does NOT run the PDFs through an LLM
----------------------------------------------------------------
The 11 Course of Study PDFs in
`_Shared/Alabama Standards/` are the human-readable documents. They are also
published as machine-readable CASE 1.0 packages by the Alabama State Department
of Education itself, at alabamastandards.org — the site ALEX embeds under its
"Standards" tab. Each package's `CFDocument.officialSourceURL` points back at the
exact PDF it was cut from, which is what lets the two be cross-checked.

That matters because of the rule in the README: nothing in this pipeline rewords a
standard. Running a 300-page PDF through gpt-4o (as `01_parse_universal.py` does
for small targeted PDFs) puts a paraphrase risk on every one of ~8,000 standards
and costs real money per rebuild. The CASE feed is the state's own structured
copy of the same text — no model in the loop at all — so the standard text here
is authoritative by construction rather than by verification.

We still verify against the PDF. Every extracted statement is checked verbatim
against `pdftotext` output of the local PDF, and `verbatim_ok` records the result
honestly per chunk.

On `verbatim_ok=False`: unlike the LLM parsers, a miss here is NOT evidence of a
fabricated standard — there is no model to fabricate one. It means pdftotext and
the CASE feed disagree on characters, which happens for real, boring reasons:
statements laid out across table cells, soft hyphenation, ligatures, and PDF
revisions (the Science CASE package cites the 2023 V1.0 file while ALSDE now
ships V1.1). So these chunks are kept and flagged, not dropped — silently
discarding a real state standard because Poppler mangled a table cell would be
the worse failure. `--strict` drops them instead if you disagree.

Grade scope: **9-12 only, by default.** This is a high school app — Florence High
School, AP Lang and ENG 101/102 — so the elementary and middle grades are noise in
the Subject/Grade dropdowns and ~64% of the chunks. `--grades` widens it if a
K-8 need ever appears; nothing else in the pipeline assumes a range.

Usage:
    python scripts/01d_ingest_alcos_case.py                 # all frameworks, grades 9-12
    python scripts/01d_ingest_alcos_case.py --only ELA Math
    python scripts/01d_ingest_alcos_case.py --grades 0-12    # include K-8
    python scripts/01d_ingest_alcos_case.py --strict         # drop verbatim misses
    python scripts/01d_ingest_alcos_case.py --refresh        # re-download packages

Writes: alcos_chunks.json  (picked up by scripts/02_embed_store.py's *chunks.json glob)
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import sys
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CASE_CACHE = PROJECT_ROOT / "data" / "raw" / "case"
# Moved under the year-named teaching folder in the 2026-07-20 IrisOS reorg —
# used to be a sibling of FlexedAcademy itself (PROJECT_ROOT.parent).
PDF_DIR = PROJECT_ROOT.parent / "Florence High School 2026-2027" / "_Shared" / "Alabama Standards"
OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "alcos_chunks.json"

CASE_API = "https://alabamastandards.org/ims/case/v1p0/CFPackages"

log = logging.getLogger("alcos")

# ---------------------------------------------------------------------------
# The frameworks, one per subject Course of Study PDF.
#
# `course` is the value written to chunk metadata and the value the app filters
# on. It must match the framework ids the /api/frameworks endpoint hands the UI,
# which is derived from these chunks — so this table is the single place a
# subject code is decided.
# ---------------------------------------------------------------------------
FRAMEWORKS = [
    # course           CASE package id                          local PDF filename
    ("ELA",             "d5af742b-1042-4647-a45a-027e4c4a2f1f", "English Language Arts (2021).pdf"),
    ("Math",            "0c01a9eb-4d20-4578-89fb-3876b435c3d4", "Mathematics (2019, rev 2021).pdf"),
    ("Science",         "d90c97ad-c327-4799-97bc-37789308baab", "Science (2023).pdf"),
    ("Social_Studies",  "5936b8cf-ae38-49ca-aa4c-85707bbdef07", "Social Studies (2024).pdf"),
    ("Arts",            "1de51ebf-fdb5-4a4a-bc68-3fab6e6ed7d6", "Arts Education (2024).pdf"),
    ("DLCS",            "8ab34547-b2e8-4189-9aad-ea232df02fbd", "Digital Literacy and Computer Science (2025).pdf"),
    ("Health",          "2adb1f52-c078-4c1c-b559-62f58832fc68", "Health Education (2019).pdf"),
    ("PE",              "98581f63-d6b5-4cad-982e-73c26ff0ff57", "Physical Education (2019).pdf"),
    ("World_Languages", "63b660d5-e540-49ae-84f5-0cd99cdf1eb9", "World Languages (2017).pdf"),
    ("Counseling",      "93710213-5d54-4326-b1d5-660a933dd3bd", "Comprehensive School Counseling (2024-2026).pdf"),
    ("Math_AWF",        "edd52d0d-4c05-4f4b-bcd4-f51897db339f", "_Superseded/Mathematics - Algebra with Finance (2015).pdf"),
]

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


def fetch_package(case_id: str, refresh: bool = False) -> dict:
    CASE_CACHE.mkdir(parents=True, exist_ok=True)
    path = CASE_CACHE / f"{case_id}.json"
    if refresh or not path.is_file():
        url = f"{CASE_API}/{case_id}"
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
                     keep_grades: frozenset[int]) -> tuple[list[dict], dict]:
    pkg = fetch_package(case_id, refresh=refresh)
    doc = pkg.get("CFDocument", {})
    title = doc.get("title", course)
    log.info("%s — %s", course, title)

    items, parent_of, has_children = build_tree(pkg)
    pdf_text = pdftotext(PDF_DIR / pdf_name)
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
                "state": "AL",
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
                "official_source_url": doc.get("officialSourceURL"),
                "verbatim_ok": verbatim,
                "wordwise_ok": word_ok,
                "embed_text": _embed_text(course, title, strand, code, statement, parent_text, grade),
            })
            per_grade[grade] += 1

    total_checked = stats["verbatim_ok"] + stats["verbatim_miss"]
    rate = (stats["verbatim_ok"] / total_checked * 100) if total_checked else 0.0
    word_rate = (stats["wordwise_ok"] / total_checked * 100) if total_checked else 0.0
    log.info(
        "  %d standards -> %d chunks | verbatim %.1f%% | wording %.1f%% (%d/%d) | grades %s",
        total_checked - stats["dropped_strict"], len(chunks),
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
        "verbatim_ok": stats["verbatim_ok"], "verbatim_rate": round(rate, 1),
        "wordwise_ok": stats["wordwise_ok"], "wordwise_rate": round(word_rate, 1),
        "unmatched": stats["wordwise_miss"],
        "pdf": pdf_name,
        "pdf_text_available": bool(pdf_text),
        "official_source_url": doc.get("officialSourceURL"),
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", metavar="COURSE",
                    help="course codes to ingest (default: all)")
    ap.add_argument("--strict", action="store_true",
                    help="drop chunks whose text isn't found verbatim in the PDF")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download the CASE packages instead of using the cache")
    ap.add_argument("--grades", default="9-12", metavar="RANGE",
                    help="grades to keep, e.g. '9-12' (default), '0-12', '11'. "
                         "0 means Kindergarten.")
    args = ap.parse_args()

    try:
        keep_grades = parse_grades(args.grades)
    except ValueError as exc:
        ap.error(str(exc))

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    shown = sorted(keep_grades)
    log.info("Grade scope: %s",
             ", ".join("K" if g == 0 else str(g) for g in shown))

    if subprocess.run(["which", "pdftotext"], capture_output=True).returncode != 0:
        log.warning("pdftotext not found (brew install poppler) — "
                    "chunks will be written with verbatim_ok=false")

    selected = FRAMEWORKS
    if args.only:
        want = {c.lower() for c in args.only}
        selected = [f for f in FRAMEWORKS if f[0].lower() in want]
        if not selected:
            log.error("No framework matched %s. Known: %s",
                      args.only, ", ".join(f[0] for f in FRAMEWORKS))
            return 1

    all_chunks: list[dict] = []
    report: list[dict] = []
    for course, case_id, pdf_name in selected:
        try:
            chunks, summary = ingest_framework(
                course, case_id, pdf_name, refresh=args.refresh, strict=args.strict,
                keep_grades=keep_grades,
            )
        except Exception as exc:  # noqa: BLE001 — one bad framework must not lose the rest
            log.error("  FAILED %s: %s", course, exc)
            report.append({"course": course, "error": str(exc)})
            continue
        all_chunks.extend(chunks)
        report.append(summary)

    if not all_chunks:
        log.error("Nothing ingested.")
        return 1

    # Merge, don't clobber, when only some frameworks were requested.
    if args.only and OUTPUT_PATH.is_file():
        with open(OUTPUT_PATH, encoding="utf-8") as f:
            existing = json.load(f)
        kept = {c[0] for c in selected}
        preserved = [c for c in existing if c.get("course") not in kept]
        log.info("Merging with %d preserved chunks from other frameworks", len(preserved))
        all_chunks = preserved + all_chunks

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_chunks, f, indent=2, ensure_ascii=False)

    report_path = PROJECT_ROOT / "data" / "raw" / "ALCOS_INGEST_REPORT.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    log.info("")
    log.info("Wrote %d chunks to %s", len(all_chunks), OUTPUT_PATH.name)
    log.info("Per-course report: data/raw/%s", report_path.name)
    ok = sum(r.get("verbatim_ok", 0) for r in report)
    words = sum(r.get("wordwise_ok", 0) for r in report)
    tot = sum(r.get("standards", 0) for r in report)
    if tot:
        log.info("Verified against the local PDFs (%d standards):", tot)
        log.info("  byte-exact ....... %d (%.1f%%)", ok, ok / tot * 100)
        log.info("  wording intact ... %d (%.1f%%)", words, words / tot * 100)
        log.info("  unmatched ........ %d (%.1f%%)", tot - words, (tot - words) / tot * 100)
    # 02_embed_store.py rebuilds by default; --upsert is the opt-out.
    log.info("Next: python scripts/02_embed_store.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
