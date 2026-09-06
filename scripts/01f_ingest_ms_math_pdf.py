#!/usr/bin/env python3
"""Ingest Mississippi's 2025 Math CCRS directly from MDE's own PDF.

CSP has no 2025 record for this subject at all (its newest Mississippi Math
bucket is dated 2016 — nine years stale), so unlike every other pilot-state
course, this one can't come from scripts/01e_fetch_csp_state.py. Extracts
every (Identifier, Standard) row via pdfplumber's table mode — the document
prints these as real two-column tables, and a plain linear text pull
(pdfplumber's extract_text()) interleaves the identifier after multi-part
bullet text, which is exactly the multi-column-PDF problem
scripts/01d_ingest_alcos_case.py's own PDF fallback exists to avoid for
Alabama.

Source: https://mdek12.org/wp-content/uploads/sites/38/2025/07/CCRS-MATH-2025-ADA-Version-FINAL-July-14-2025.pdf
Cached at data/raw/ms_math_2025/ms_ccrs_math_2025.pdf

Usage:
    python scripts/01f_ingest_ms_math_pdf.py
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

import pdfplumber

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PDF_PATH = PROJECT_ROOT / "data" / "raw" / "ms_math_2025" / "ms_ccrs_math_2025.pdf"
OUT_PATH = PROJECT_ROOT / "data" / "processed" / "ms_math_csp_chunks.json"
OFFICIAL_URL = "https://mdek12.org/wp-content/uploads/sites/38/2025/07/CCRS-MATH-2025-ADA-Version-FINAL-July-14-2025.pdf"

# Running page-header text -> (course label shown to a teacher, grade).
# Built by scanning every page's first line across the K-12 body (pages
# 30-245) and cross-checking against the document's own table of contents —
# see this script's companion research, not guessed.
HEADER_MAP: dict[str, tuple[str, int]] = {
    "KINDERGARTEN": ("Kindergarten", 0),
    "GRADE 1": ("Grade 1", 1),
    "GRADE 2": ("Grade 2", 2),
    "GRADE 3": ("Grade 3", 3),
    "GRADE 4": ("Grade 4", 4),
    "GRADE 5": ("Grade 5", 5),
    "GRADE 6": ("Grade 6", 6),
    "GRADE 7": ("Grade 7", 7),
    "GRADE 8": ("Grade 8", 8),
    "COMPACTED MATH GRADE 7": ("Compacted Math Grade 7", 7),
    "COMPACTED MATH GRADE 8": ("Compacted Math Grade 8", 8),
    "FOUNDATIONS OF ALGEBRA": ("Foundations of Algebra", 99),
    "ALGEBRA I": ("CCR Algebra I", 99),
    "GEOMETRY": ("CCR Geometry", 99),
    "ALGEBRA II": ("CCR Algebra II", 99),
    "ADVANCED TECHNICAL MATH (ATM)": ("Advanced Technical Math", 99),
    "ALGEBRA III": ("CCR Algebra III", 99),
    "ADVANCED MATHEMATICS PLUS (AMP)": ("Advanced Mathematics Plus", 99),
    "CALCULUS": ("Calculus", 99),
    "SREB MATH READY": ("SREB Math Ready", 99),
    "SREB READY— HS MATH": ("SREB Math Ready", 99),
    "ESSENTIALS FOR COLLEGE MATH": ("Essentials for College Math", 99),
}

# Pages with no recognized header (title/TOC/overview/appendix prose) are
# skipped by construction — they have no (Identifier, Standard) table for
# extract_tables() to find, confirmed by inspection (e.g. the
# "HIGH SCHOOL CONCEPTUAL CATEGORIES" overview pages, prose only, no table).

# A real standard identifier always carries a digit ("K.CC.1", "N-RN.3",
# "ATM.NS.1") — some sections (Essentials for College Math) also print a
# two-column GLOSSARY table ("Square" / "Reflection" -> definition) that
# extract_tables() can't tell apart from a standards table by shape alone;
# requiring a digit is what excludes those rows.
CODE_RE = re.compile(r"^[A-Z0-9][A-Za-z0-9.\-]*$")


def looks_like_code(code: str) -> bool:
    return bool(CODE_RE.match(code)) and any(ch.isdigit() for ch in code)


# The source PDF renders inline math (stacked fractions like "a/b", exponents)
# as separately positioned glyphs, including Unicode mathematical-alphanumeric
# characters (U+1D400-U+1D7FF) standing in for italic variables. Cell-based
# table extraction can't recover their visual stacking order, so a standard
# built around a fraction sometimes comes out with its actual numbers
# scrambled (e.g. "5.NF.1"'s worked example loses which value was the
# numerator) — not just ugly, but not reliably correct. Better to exclude
# these than ship math that reads as verbatim but may not be.
def has_math_glyph_artifact(text: str) -> bool:
    return any(0x1D400 <= ord(ch) <= 0x1D7FF for ch in text)


def clean_cell(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def main() -> int:
    if not PDF_PATH.exists():
        print(f"Missing {PDF_PATH} — download it first.", file=sys.stderr)
        return 1

    pdf_sha256 = hashlib.sha256(PDF_PATH.read_bytes()).hexdigest()
    now = datetime.now(UTC).isoformat()

    chunks: list[dict] = []
    current_header: str | None = None
    seen_exact: set[tuple] = set()
    skipped_fraction_artifacts: list[str] = []

    with pdfplumber.open(PDF_PATH) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            first_line = text.strip().split("\n")[0].strip() if text.strip() else ""
            if first_line in HEADER_MAP:
                current_header = first_line
            if current_header is None:
                continue

            course_label, grade = HEADER_MAP[current_header]
            for table in page.extract_tables():
                for row in table:
                    if not row or len(row) < 2:
                        continue
                    code = clean_cell(row[0])
                    description = clean_cell(row[1])
                    if not code or not description:
                        continue
                    if not looks_like_code(code):
                        continue
                    if has_math_glyph_artifact(description):
                        skipped_fraction_artifacts.append(code)
                        continue

                    exact_key = (grade, code, description)
                    if exact_key in seen_exact:
                        continue
                    seen_exact.add(exact_key)

                    chunks.append({
                        "code": code,
                        "description": description,
                        "course": "Math",
                        "grade": grade,
                        "state": "MS",
                        "source_type": "state_course_of_study",
                        "source_document": "2025 Mississippi College- and Career-Readiness Standards - Mathematics.pdf",
                        "source_page_or_section": course_label,
                        "strand": None,
                        "parent_code": None,
                        "parent_text": None,
                        "notes": [],
                        "embed_text": f"[{code}] {description}",
                        "verbatim_ok": True,  # extracted directly from the PDF's own table, no paraphrase
                        "official_source_url": OFFICIAL_URL,
                        "source_pdf_sha256": pdf_sha256,
                        "source_ingested_at": now,
                        "csp_subject": None,
                        "csp_standard_set_id": None,
                    })

    by_course_label: dict[str, int] = {}
    for c in chunks:
        by_course_label[c["source_page_or_section"]] = by_course_label.get(c["source_page_or_section"], 0) + 1
    for label, count in sorted(by_course_label.items()):
        print(f"  {label}: {count}")
    print(f"Total: {len(chunks)} chunks")
    if skipped_fraction_artifacts:
        print(
            f"Excluded {len(skipped_fraction_artifacts)} standard(s) whose fraction/exponent "
            f"notation the PDF's layout scrambled beyond reliable extraction: {sorted(skipped_fraction_artifacts)}"
        )

    OUT_PATH.write_text(json.dumps(chunks, indent=2))
    print(f"Wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
