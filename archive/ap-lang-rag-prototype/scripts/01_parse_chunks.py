#!/usr/bin/env python3
"""
Step 1 — Parse the three source documents into structured, tagged chunks.

    python scripts/01_parse_chunks.py            # write chunks.json + print samples
    python scripts/01_parse_chunks.py --samples  # samples only, no write

DESIGN RULE THAT OVERRIDES EVERYTHING ELSE IN THIS FILE
-------------------------------------------------------
This parser never rewords a standard. It extracts and it reformats *structure*
only: joining lines the PDF wrapped mid-sentence, stripping page furniture,
separating a code label from the text it precedes. The substantive words of a
standard are carried through byte-for-byte from the source.

That is not fussiness. `source_docs/quarantine/` holds a file where an AI tool
"cleaned up" this exact content and silently replaced three standards with
plausible inventions (see SPOT_CHECK_step1.md). The entire value of a RAG system
over just asking a model is that the retrieved text is real. A parser that
paraphrases destroys that guarantee at the very first step, and nothing
downstream can detect it.

So: every chunk gets a `verbatim_ok` flag, and every extracted description is
checked back against the raw source text it came from. If normalization ever
changes a description's words, the check fails loudly rather than shipping.

OUTPUT: chunks.json — a list of dicts matching the metadata schema in README.md.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DOCS = PROJECT_ROOT / "source_docs"
OUTPUT_PATH = PROJECT_ROOT / "chunks.json"

# --- Course-level constants -------------------------------------------------
# Phase 1 populates one value each. The fields exist because Phase 2 scopes
# retrieval by them for other teachers/courses, and adding a metadata field to
# an already-populated vector store means a full re-index.
COURSE = "AP_Lang"
GRADE = 11
STATE = "AL"

# ALCOS Grade 11 lives at PDF pages 133-138 (printed 122-127). Page 139 is
# Grade 12, which numbers ITS standards 1-30 as well -- an off-by-one here
# silently mixes two grades' standards under the same codes. Asserted below.
ALCOS_FIRST_PAGE = 133
ALCOS_LAST_PAGE = 138
ALCOS_PAGE_OFFSET = -11  # PDF page 133 -> printed page 122


# ---------------------------------------------------------------------------
# Chunk model
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    """One retrievable standard.

    `description` is verbatim source text. `embed_text` is what actually gets
    vectorized -- it adds structural context (strand, parent standard, examples)
    that helps a semantic query land on the right chunk but is NOT part of the
    standard's own language. Keeping them separate is what lets the generator
    quote a standard without accidentally quoting our scaffolding as if the
    state had written it.
    """

    code: str
    description: str
    course: str
    grade: int
    state: str
    source_type: str
    source_document: str
    source_page_or_section: str

    # Structural context -- varies by source type, hence the defaults.
    strand: str | None = None
    mode: str | None = None            # Reading / Listening / Writing / Speaking
    domain: str | None = None          # Reception / Expression
    sub_skill: str | None = None       # AP: the Reading/Writing sub-skill heading
    score_band: str | None = None      # ACT: 13-15 ... 33-36
    reporting_category: str | None = None
    frequency: int | None = None       # AP: appearances across Units 1-7
    examples: str | None = None        # verbatim "Examples:" text, if any
    parent_code: str | None = None
    parent_text: str | None = None
    notes: list[str] = field(default_factory=list)

    embed_text: str = ""
    verbatim_ok: bool = False

    def build_embed_text(self) -> None:
        """Assemble the string that gets embedded.

        Order matters a little: the standard's own text comes first so it
        dominates the vector, with context trailing.
        """
        parts: list[str] = []
        header = " | ".join(p for p in [self.strand, self.sub_skill, self.mode] if p)
        if header:
            parts.append(header)
        parts.append(f"{self.code}: {self.description}")
        if self.parent_text:
            parts.append(f"(Part of {self.parent_code}: {self.parent_text})")
        if self.examples:
            # Included deliberately: a query like "teaching blueprints" or
            # "timelines" only reaches ALCOS standard 2 via its examples list.
            parts.append(f"Examples: {self.examples}")
        self.embed_text = "\n".join(parts)


# ---------------------------------------------------------------------------
# Text hygiene
# ---------------------------------------------------------------------------

def normalize_ws(text: str) -> str:
    """Collapse the whitespace `pdftotext -layout` leaves behind.

    Structure only: runs of spaces/newlines become single spaces. No word is
    added, removed, or changed.
    """
    return re.sub(r"\s+", " ", text).strip()


def comparable(text: str) -> str:
    """Reduce text to a form for verbatim comparison.

    Folds the things that legitimately differ between a PDF's glyphs and our
    output -- curly quotes, en/em dashes, ligatures, whitespace -- and nothing
    else. Used only by the verbatim check, never on stored text.
    """
    text = unicodedata.normalize("NFKD", text)
    for a, b in [("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'),
                 ("–", "-"), ("—", "-"), ("−", "-"), (" ", " ")]:
        text = text.replace(a, b)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def pdftotext(pdf: Path, first: int | None = None, last: int | None = None, layout: bool = True) -> str:
    """Extract text from a PDF.
    
    When layout=True (default), preserves positional structure needed for parsing.
    When layout=False, extracts in reading order, useful for pure text verification.
    """
    cmd = ["pdftotext"]
    if layout:
        cmd.append("-layout")
    if first is not None:
        cmd += ["-f", str(first)]
    if last is not None:
        cmd += ["-l", str(last)]
    cmd += [str(pdf), "-"]
    try:
        out = subprocess.run(cmd, capture_output=True, check=True, text=True)
    except FileNotFoundError:
        sys.exit("pdftotext not found. Install poppler:  brew install poppler")
    except subprocess.CalledProcessError as exc:
        sys.exit(f"pdftotext failed on {pdf.name}: {exc.stderr}")
    return out.stdout


# ---------------------------------------------------------------------------
# Source 1 — Alabama Course of Study, Grade 11
# ---------------------------------------------------------------------------

# Strand headings, in document order, with the standard numbers each covers and
# the mode assigned to each number. Mode comes from labels in the PDF's left
# gutter (RECEPTION/EXPRESSION and READING/LISTENING/WRITING/SPEAKING); the
# gutter is a rotated table cell spanning several rows, so pdftotext emits it
# once at an arbitrary row rather than beside each standard. Reconstructing it
# positionally is unreliable, so the mapping is transcribed explicitly from the
# document and asserted for completeness. Verified against PDF pp. 134-138.
ALCOS_STRANDS: list[tuple[str, dict[str, list[int]]]] = [
    ("CRITICAL LITERACY", {
        "Reading":   [1, 2, 3, 4, 5, 6, 7, 8, 9],
        "Listening": [10],
        "Writing":   [11, 12],
        "Speaking":  [13, 14],
    }),
    ("DIGITAL LITERACY", {
        "Reading": [15], "Listening": [16], "Writing": [17], "Speaking": [18],
    }),
    ("LANGUAGE LITERACY", {
        "Reading": [19], "Listening": [20, 21], "Writing": [22], "Speaking": [23],
    }),
    ("RESEARCH LITERACY", {
        "Reading": [24, 25], "Listening": [26], "Writing": [27, 28, 29], "Speaking": [30],
    }),
]

# Reception = taking language in, Expression = putting it out. The document
# groups modes under these two headings.
DOMAIN_BY_MODE = {
    "Reading": "Reception", "Listening": "Reception",
    "Writing": "Expression", "Speaking": "Expression",
}

# R1-R7 domain headings as printed ("Reception" above R1-R3, "Expression" above
# R4-R7). The recurring block carries no Reading/Listening/Writing/Speaking
# sub-labels, so `mode` stays None for these rather than being guessed.
RECURRING_DOMAIN = {
    "R1": "Reception", "R2": "Reception", "R3": "Reception",
    "R4": "Expression", "R5": "Expression", "R6": "Expression", "R7": "Expression",
}

# Page furniture to drop: running footer, grade running-head, section titles.
ALCOS_NOISE = re.compile(
    r"^\s*(?:\d+\s+)?2021 Alabama Course of Study: English Language Arts\s*\d*\s*$"
    r"|^\s*Grade \d+\s*$"
    r"|^\s*GRADE \d+\s*$"
    r"|^\s*GRADE \d+ CONTENT STANDARDS\s*$"
    r"|^\s*RECURRING STANDARDS FOR GRADES 9-12\s*$"
    r"|^\s*Students will:\s*$"
    r"|^\s*(?:Reception|Expression)\s*$"
    r"|^\s*(?:RECEPTION|EXPRESSION)\s+(?:READING|LISTENING|WRITING|SPEAKING)\s*$"
    r"|^\s*(?:RECEPTION|EXPRESSION)\s*$"
    r"|^\s*(?:READING|LISTENING|WRITING|SPEAKING)\s*$"
    r"|^\s*Each content standard completes the stem\b",
    re.IGNORECASE,
)


def _page_label(pdf_page: int) -> str:
    return f"PDF p.{pdf_page} (printed p.{pdf_page + ALCOS_PAGE_OFFSET})"


def _split_examples(body: str) -> tuple[str, str | None]:
    """Peel a trailing 'Examples:' / 'Example:' clause off a standard's text.

    Returned separately so the generator can distinguish state-authored
    standard language from illustration and never cite an example as if it were
    the standard.
    """
    m = re.search(r"\bExamples?:\s*", body)
    if not m:
        return normalize_ws(body), None
    return normalize_ws(body[: m.start()]), normalize_ws(body[m.end():]) or None


def parse_alcos(pdf: Path) -> list[Chunk]:
    raw_pages = pdftotext(pdf, ALCOS_FIRST_PAGE, ALCOS_LAST_PAGE).split("\f")
    pages = [(ALCOS_FIRST_PAGE + i, txt) for i, txt in enumerate(raw_pages) if txt.strip()]

    # Guardrail: page 139 is Grade 12 and re-uses standard numbers 1-30.
    full = "\n".join(t for _, t in pages)
    assert "GRADE 12" not in full.upper(), (
        "Grade 12 content leaked into the Grade 11 page range -- check "
        f"ALCOS_FIRST_PAGE/ALCOS_LAST_PAGE ({ALCOS_FIRST_PAGE}-{ALCOS_LAST_PAGE})."
    )
    assert "GRADE 11" in full.upper(), "Grade 11 header not found; page range is wrong."

    chunks: list[Chunk] = []
    chunks += _parse_recurring(pages, pdf.name)
    chunks += _parse_content_standards(pages, pdf.name)
    return chunks


def _parse_recurring(pages, doc_name: str) -> list[Chunk]:
    """R1-R7, the Grades 9-12 Recurring Standards (PDF p.133 / printed p.122).

    Tagged `act_recurring` per the schema. (The name is a schema label, not a
    claim about ACT -- these are Alabama recurring standards.)
    """
    page_no, text = pages[0]
    lines = [ln for ln in text.split("\n") if not ALCOS_NOISE.match(ln)]

    # R-codes start a standard; continuation lines are indented under them.
    entries: dict[str, list[str]] = {}
    current: str | None = None
    for ln in lines:
        m = re.match(r"^\s*(R[1-7])\.\s+(.*)$", ln)
        if m:
            current = m.group(1)
            entries[current] = [m.group(2)]
        elif current and ln.strip():
            entries[current].append(ln.strip())

    out: list[Chunk] = []
    for code in [f"R{i}" for i in range(1, 8)]:
        assert code in entries, f"Recurring standard {code} not found on PDF p.{page_no}"
        desc, examples = _split_examples(" ".join(entries[code]))
        out.append(Chunk(
            code=code,
            description=desc,
            course=COURSE, grade=GRADE, state=STATE,
            source_type="act_recurring",
            source_document=doc_name,
            source_page_or_section=f"{_page_label(page_no)} — Recurring Standards for Grades 9–12",
            strand="Recurring Standards for Grades 9–12",
            domain=RECURRING_DOMAIN[code],
            examples=examples,
            notes=["Applies across all of Grades 9–12, not Grade 11 alone.",
                   "Reprinted under each grade 9–12 with trivial punctuation "
                   "differences; the Grade 11 printing is used here."],
        ))
    return out


def _parse_content_standards(pages, doc_name: str) -> list[Chunk]:
    """Grade 11 content standards 1-30, plus lettered sub-parts.

    Two-pass: collect the raw line groups for each numbered standard and each
    sub-part first, then build chunks. Doing it in one pass tangles the
    strand-header state machine with the sub-part logic and gets fragile.
    """
    # number -> (page, [lines]);  (number, letter) -> (page, [lines])
    numbered: dict[int, tuple[int, list[str]]] = {}
    lettered: dict[tuple[int, str], tuple[int, list[str]]] = {}
    target: list[str] | None = None

    for page_no, text in pages[1:]:  # pages[0] is the recurring-standards page
        for ln in text.split("\n"):
            if ALCOS_NOISE.match(ln) or not ln.strip():
                continue
            if re.match(r"^\s*(?:CRITICAL|DIGITAL|LANGUAGE|RESEARCH) LITERACY\s*$", ln, re.I):
                target = None  # strand blurb follows; ignore until next code
                continue

            # pdftotext -layout sometimes merges domain/mode labels onto the same line
            # as a standard's text. Strip them from the start of the line.
            ln = re.sub(r"^(?:\s*(?:RECEPTION|EXPRESSION|READING|LISTENING|WRITING|SPEAKING))+\s*", "", ln)

            # "11. Compose and edit..."  -- a new numbered standard
            m_num = re.match(r"^\s*(\d{1,2})\.\s+(\S.*)$", ln)
            # "a. Incorporate narrative techniques..." -- a sub-part
            m_let = re.match(r"^\s*([a-c])\.\s+(\S.*)$", ln)

            if m_num and 1 <= int(m_num.group(1)) <= 30:
                num = int(m_num.group(1))
                numbered[num] = (page_no, [m_num.group(2)])
                target = numbered[num][1]
                last_num = num
            elif m_let and target is not None:
                key = (last_num, m_let.group(1))
                lettered[key] = (page_no, [m_let.group(2)])
                target = lettered[key][1]
            elif target is not None:
                target.append(ln.strip())

    # Invert the strand map: number -> (strand, mode)
    number_meta: dict[int, tuple[str, str]] = {}
    for strand, modes in ALCOS_STRANDS:
        for mode, nums in modes.items():
            for n in nums:
                number_meta[n] = (strand, mode)

    missing = sorted(set(range(1, 31)) - set(numbered))
    assert not missing, f"ALCOS Grade 11 standards not parsed: {missing}"
    assert set(number_meta) == set(range(1, 31)), "ALCOS_STRANDS does not cover 1–30"

    out: list[Chunk] = []
    parent_desc: dict[int, str] = {}

    for num in sorted(numbered):
        page_no, lines = numbered[num]
        strand, mode = number_meta[num]
        desc, examples = _split_examples(" ".join(lines))
        parent_desc[num] = desc
        out.append(Chunk(
            code=f"Grade11-{num}",
            description=desc,
            course=COURSE, grade=GRADE, state=STATE,
            source_type="state_course_of_study",
            source_document=doc_name,
            source_page_or_section=f"{_page_label(page_no)} — {strand}, standard {num}",
            strand=strand, mode=mode, domain=DOMAIN_BY_MODE[mode],
            examples=examples,
        ))

    for (num, letter) in sorted(lettered):
        page_no, lines = lettered[(num, letter)]
        strand, mode = number_meta[num]
        desc, examples = _split_examples(" ".join(lines))
        out.append(Chunk(
            code=f"Grade11-{num}{letter}",
            description=desc,
            course=COURSE, grade=GRADE, state=STATE,
            source_type="state_course_of_study",
            source_document=doc_name,
            source_page_or_section=f"{_page_label(page_no)} — {strand}, standard {num}{letter}",
            strand=strand, mode=mode, domain=DOMAIN_BY_MODE[mode],
            examples=examples,
            parent_code=f"Grade11-{num}",
            parent_text=parent_desc[num],
        ))
    return out


# ---------------------------------------------------------------------------
# Source 2 — AP Lang skills (Units 1-7)
# ---------------------------------------------------------------------------

AP_STRANDS = {
    "RHS": "Rhetorical Situation",
    "CLE": "Claims and Evidence",
    "REO": "Reasoning and Organization",
    "STL": "Style",
}

AP_UNITS_NOTE = (
    "Source document covers Units 1–7 of 9. Units 8–9 skills are not in this "
    "document; the frequency count reflects Units 1–7 only and understates "
    "course-wide weight. No codes exist here for Units 8–9."
)


def parse_ap_skills(pdf: Path) -> list[Chunk]:
    """Parse strand -> sub-skill -> lettered code.

    Layout, per page: a strand header with its description, then alternating
    Reading/Writing sub-skill headers, then rows like

            Identify and describe components of the rhetorical situation:
       1A.  the exigence, audience, writer, purpose, context, and message.    3

    The code label sits in a left column and the frequency count in a right
    column, and the description wraps across lines *above and below* the code
    label. So a row's text is: any pending unattached lines + the text on the
    code's own line + following lines until the next code/header. The pending
    buffer is what makes this work.
    """
    text = pdftotext(pdf)

    strand_re = re.compile(
        r"^\s*(Rhetorical Situation|Claims and Evidence|Reasoning and Organization|Style)"
        r"\s*\((RHS|CLE|REO|STL)\)\s*[-–—]\s*(.*)$"
    )
    sub_re = re.compile(
        r"^\s*(Rhetorical Situation|Claims and Evidence|Reasoning and Organization|Style)"
        r"\s*[–-]\s*(Reading|Writing)\s*[-–—]?\s*(.*)$"
    )
    code_re = re.compile(r"^\s*([1-8][ABC])\.\s*(.*?)\s*(?:(\d+)\s*)?$")
    noise_re = re.compile(
        r"AP® is a trademark|Bedford, Freeman & Worth|^\s*AP English Language"
        r"|Skills from Units|©\s*\d{4}", re.IGNORECASE)

    strand_code = strand_name = sub_skill = mode = None
    pending: list[str] = []           # description lines seen before the code label
    rows: list[tuple[str, str, int | None, str, str, str, str]] = []
    cur: dict | None = None

    def flush() -> None:
        nonlocal cur
        if cur is not None:
            rows.append((cur["code"], normalize_ws(" ".join(cur["lines"])),
                         cur["freq"], cur["strand_code"], cur["strand_name"],
                         cur["sub_skill"], cur["mode"]))
            cur = None

    for ln in text.split("\n"):
        if noise_re.search(ln):
            continue
        if not ln.strip():
            if cur is not None:
                flush()
            continue

        m_strand = strand_re.match(ln)
        if m_strand:
            flush(); pending.clear()
            strand_name, strand_code = m_strand.group(1), m_strand.group(2)
            sub_skill = mode = None
            continue

        m_sub = sub_re.match(ln)
        if m_sub and strand_code:
            flush(); pending.clear()
            mode = m_sub.group(2)
            sub_skill = normalize_ws(f"{m_sub.group(1)} – {mode} – {m_sub.group(3)}")
            continue

        m_code = code_re.match(ln)
        if m_code and strand_code and mode:
            flush()
            body = m_code.group(2)
            freq = int(m_code.group(3)) if m_code.group(3) else None
            cur = {
                "code": m_code.group(1),
                # Lines that arrived before the code label belong to THIS row.
                "lines": pending + ([body] if body else []),
                "freq": freq,
                "strand_code": strand_code, "strand_name": strand_name,
                "sub_skill": sub_skill, "mode": mode,
            }
            pending = []
            continue

        # Unattached prose: continuation of the open row, else buffer it for
        # the next code label.
        leading_spaces = len(ln) - len(ln.lstrip())
        stripped = ln.strip()
        if cur is not None:
            # A trailing bare integer on a continuation line is the frequency
            # column, not part of the standard.
            m_tail = re.match(r"^(.*?)\s+(\d+)$", stripped)
            if m_tail and cur["freq"] is None:
                cur["lines"].append(m_tail.group(1))
                cur["freq"] = int(m_tail.group(2))
            else:
                cur["lines"].append(stripped)
        elif strand_code and mode:
            if leading_spaces < 12:
                # Continuation of the sub-skill description
                sub_skill = f"{sub_skill} {stripped}"
            else:
                pending.append(stripped)
    flush()

    out: list[Chunk] = []
    for code, desc, freq, s_code, s_name, sub_skill, mode in rows:
        # Codes print as "1A" but are conventionally written "1.A" in lesson
        # plans and in Josh's existing skill. Store the dotted form and keep
        # the printed form searchable via aliases in step 2.
        dotted = f"{code[0]}.{code[1]}"
        out.append(Chunk(
            code=dotted,
            description=desc,
            course=COURSE, grade=GRADE, state=STATE,
            source_type="ap_skills",
            source_document=pdf.name,
            source_page_or_section=f"{s_name} ({s_code}) — {sub_skill}",
            strand=f"{s_name} ({s_code})",
            mode=mode,
            sub_skill=sub_skill,
            frequency=freq,
            notes=[AP_UNITS_NOTE],
        ))

    codes = [c.code for c in out]
    # 1.C and 2.C do not exist in the AP Lang skills framework.
    expected = [f"{n}.{l}" for n in range(3, 9) for l in "ABC"] + ["1.A", "1.B", "2.A", "2.B"]
    missing = [c for c in expected if c not in codes]
    assert not missing, f"AP skill codes not parsed: {missing}"
    assert len(codes) == len(set(codes)), f"duplicate AP codes: {codes}"
    return out


# ---------------------------------------------------------------------------
# Source 3 — ACT English/Writing standards
# ---------------------------------------------------------------------------

ACT_CATEGORIES = {
    "TOD": "Topic Development in Terms of Purpose and Focus",
    "ORG": "Organization, Unity, and Cohesion",
    "KLA": "Knowledge of Language",
    "SST": "Sentence Structure and Formation",
    "USG": "Usage Conventions",
    "PUN": "Punctuation Conventions",
}

ACT_SCOPE_NOTE = (
    "ACT English/Writing only. ACT Reading-specific codes are a separate set "
    "and are not in this source. The 'Ideas for Progress' category came through "
    "with score-range headers but no codes, so nothing from it is citable."
)


def parse_act(md: Path) -> list[Chunk]:
    """Parse the ACT markdown: '## Section' / '### Category (ABC)' / '**band**' / '- ABC 501. text'."""
    section = category = cat_code = band = None
    out: list[Chunk] = []
    in_gap_section = False

    for raw in md.read_text(encoding="utf-8").split("\n"):
        ln = raw.rstrip()

        if ln.startswith("## "):
            section = ln[3:].strip()
            # Everything under "Not yet included" is caveat prose, not standards.
            in_gap_section = section.lower().startswith("not yet included")
            category = cat_code = band = None
            continue
        if in_gap_section:
            continue
        m_cat = re.match(r"^###\s+(.*?)\s*\(([A-Z]{3})\)\s*$", ln)
        if m_cat:
            category, cat_code = m_cat.group(1), m_cat.group(2)
            band = None
            continue
        m_band = re.match(r"^\*\*(.+?)\*\*\s*$", ln)
        if m_band:
            band = m_band.group(1).strip()
            continue
        m_code = re.match(r"^-\s+([A-Z]{3})\s+(\d{3})\.\s+(.*)$", ln)
        if m_code and cat_code:
            fam, num, desc = m_code.groups()
            assert fam == cat_code, f"code family {fam} under category {cat_code}"
            out.append(Chunk(
                code=f"{fam} {num}",
                description=normalize_ws(desc),
                course=COURSE, grade=GRADE, state=STATE,
                source_type="act_standards",
                source_document=md.name,
                source_page_or_section=f"{section} — {category} ({fam}), score band {band}",
                strand=section,
                reporting_category=f"{category} ({fam})",
                score_band=band,
                notes=[ACT_SCOPE_NOTE],
            ))

    found = {c.code.split()[0] for c in out}
    assert found == set(ACT_CATEGORIES), (
        f"ACT categories parsed {sorted(found)}, expected {sorted(ACT_CATEGORIES)}")
    assert len(out) == len({c.code for c in out}), "duplicate ACT codes"
    return out


# ---------------------------------------------------------------------------
# Verbatim verification
# ---------------------------------------------------------------------------

def verify_verbatim(chunks: list[Chunk], raw_by_doc: dict[str, str]) -> list[Chunk]:
    """Assert every description's words appear, in order, in the raw source.

    This is the guard against the failure mode in `quarantine/`. Whitespace,
    quote style, and dashes are folded (a PDF's glyphs legitimately differ from
    our output); every letter and digit must match. Any chunk whose text we
    somehow altered gets flagged rather than silently shipped.
    """
    folded = {doc: comparable(raw) for doc, raw in raw_by_doc.items()}
    for ch in chunks:
        haystack = folded.get(ch.source_document, "")
        ch.verbatim_ok = comparable(ch.description) in haystack
    return chunks


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_samples(chunks: list[Chunk], raw_by_doc: dict[str, str], n: int = 5) -> None:
    by_doc: dict[str, list[Chunk]] = {}
    for ch in chunks:
        by_doc.setdefault(ch.source_document, []).append(ch)

    for doc, group in by_doc.items():
        print("\n" + "=" * 78)
        print(f"{doc}  —  {len(group)} chunks")
        print("=" * 78)
        # Spread the sample across the document rather than taking the first n,
        # so a parser that only works on page 1 is visible.
        step = max(1, len(group) // n)
        for ch in group[::step][:n]:
            print(f"\n  code   : {ch.code}")
            print(f"  verbatim: {'PASS' if ch.verbatim_ok else '*** FAIL ***'}")
            print(f"  desc   : {ch.description}")
            if ch.examples:
                print(f"  examples: {ch.examples}")
            for label, val in [("strand", ch.strand), ("sub_skill", ch.sub_skill),
                               ("mode", ch.mode), ("domain", ch.domain),
                               ("score_band", ch.score_band),
                               ("frequency", ch.frequency),
                               ("parent", ch.parent_code)]:
                if val is not None:
                    print(f"  {label:8}: {val}")
            print(f"  source : {ch.source_page_or_section}")


def summarize(chunks: list[Chunk]) -> None:
    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    counts: dict[str, int] = {}
    for ch in chunks:
        counts[ch.source_type] = counts.get(ch.source_type, 0) + 1
    for k in sorted(counts):
        print(f"  {k:26} {counts[k]:4}")
    print(f"  {'TOTAL':26} {len(chunks):4}")

    failed = [c for c in chunks if not c.verbatim_ok]
    print(f"\n  verbatim check: {len(chunks) - len(failed)}/{len(chunks)} pass")
    if failed:
        print("  *** FAILURES — text differs from source, do not embed: ***")
        for c in failed:
            print(f"      {c.code}: {c.description[:90]}")
    dupes = {c.code for c in chunks if [x.code for x in chunks].count(c.code) > 1}
    if dupes:
        print(f"  *** DUPLICATE CODES: {sorted(dupes)} ***")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", action="store_true",
                    help="print samples only; do not write chunks.json")
    ap.add_argument("-n", type=int, default=5, help="samples per document")
    args = ap.parse_args()

    alcos = SOURCE_DOCS / "alcos_ela.pdf"
    aplang = SOURCE_DOCS / "APLangSkills.pdf"
    act = SOURCE_DOCS / "act-english-standards.md"
    for p in (alcos, aplang, act):
        if not p.exists():
            sys.exit(f"missing source document: {p}")

    chunks = parse_alcos(alcos) + parse_ap_skills(aplang) + parse_act(act)

    raw_by_doc = {
        alcos.name: pdftotext(alcos, ALCOS_FIRST_PAGE, ALCOS_LAST_PAGE, layout=False),
        aplang.name: pdftotext(aplang, layout=False),
        act.name: act.read_text(encoding="utf-8"),
    }
    chunks = verify_verbatim(chunks, raw_by_doc)
    for ch in chunks:
        ch.build_embed_text()

    print_samples(chunks, raw_by_doc, args.n)
    summarize(chunks)

    if not args.samples:
        OUTPUT_PATH.write_text(
            json.dumps([asdict(c) for c in chunks], indent=2, ensure_ascii=False),
            encoding="utf-8")
        print(f"\nwrote {len(chunks)} chunks -> {OUTPUT_PATH.relative_to(PROJECT_ROOT)}")

    return 1 if any(not c.verbatim_ok for c in chunks) else 0


if __name__ == "__main__":
    sys.exit(main())
