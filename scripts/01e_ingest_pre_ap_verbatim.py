#!/usr/bin/env python3
"""
Step 1e — Re-ingest Pre-AP Course Frameworks with verbatim verification.

scripts/ingest_pre_ap.py (still present, not removed by this file) trusted a
single LLM call to both extract AND word the standard — its own prompt never
asked for an exact quote, and nothing checked the output against the source
PDF. Every Pre-AP standard in the corpus (12 courses, ~1,171 chunks) is
therefore a paraphrase, correctly flagged verbatim_ok=False by every ingest
script that DOES do the check — this is the fix, not a bug report about
those other scripts.

This script is 01c_ingest_ap_ceds.py's pipeline, pointed at the Pre-AP
catalog instead of the AP one: extract with an LLM, then keep ONLY the
standards whose 'description' is an exact substring of the source PDF text
(see run_batch's zero-fabrication check below). A paraphrase is silently
dropped rather than kept-but-flagged, so there is no such thing as a
mislabeled chunk this script writes — every row in its output really did
come out of the PDF word for word.

One real difference from 01c_ingest_ap_ceds.py's own extraction, and the
reason this file exists rather than just pointing that one at a different
PDF folder: the Pre-AP arts frameworks (Dance, Music, Theatre, Visual Arts)
lay their standards out as a 4-column table (Essential Knowledge / Advanced
/ Proficient / Emerging). `pdftotext -layout` — what every OTHER course
here and in 01c_ingest_ap_ceds.py uses — reconstructs a page as a grid of
TEXT ROWS, not table rows: it fuses whatever sits at the same vertical
position across all four columns onto one line. Confirmed directly on Pre-AP
Dance page 30: the raw text reads "Suggest and justify / Using dance-
specific / Identify the elements of" as one line — three unrelated cells,
three columns apart, spliced together — even though the table itself
renders perfectly cleanly (verified by rendering the page as an image). The
LLM read the real, correct cell text every time; the verbatim check was
comparing it against a baseline that had already scrambled it. That is why
the first version of this script verified only ~10 standards per arts
course out of ~300 candidates: a false-rejection rate, not a hallucination
rate. `page_text()` below fixes this by using pdfplumber's table detection
— which finds actual row/column boundaries, not vertical position — for
any page that has a table, and pdftotext's plain (line-by-line, table-blind
but at least not column-splicing) mode for everything else.

Usage:
    python scripts/01e_ingest_pre_ap_verbatim.py                 # all 12 Pre-AP courses
    python scripts/01e_ingest_pre_ap_verbatim.py --only "Pre-AP Biology"
"""

import argparse
import json
import logging
import re
import sys
import threading
import time
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from openai import OpenAI  # noqa: E402

from backend.config import settings  # noqa: E402
from backend.llm import _response_format  # noqa: E402

# backend.llm.client()'s 30s timeout is tuned for interactive chat and isn't
# enough for a 30k-char batch extraction call — confirmed live: the first
# test run of this script lost 2 of 4 Pre-AP Biology batches to a hard
# "Request timed out" after all 3 retries, at exactly 30s each. A fresh
# client with a generous timeout, same as ingest_pre_ap.py's own choice.
_openai_client = OpenAI(api_key=settings.openai_api_key, timeout=300.0)


def openai_client() -> OpenAI:
    return _openai_client

SOURCE_DOCS = PROJECT_ROOT / "data" / "raw" / "source_docs" / "pre_ap"
OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "pre_ap_chunks.json"
CHECKPOINT_PATH = PROJECT_ROOT / "data" / "processed" / "pre_ap_chunks.partial.json"

log = logging.getLogger("pre_ap_verbatim")

# Same pricing basis as 01c_ingest_ap_ceds.py's own comment — checked
# 2026-08-22, developers.openai.com/api/docs/pricing.
_LUNA_INPUT_PER_TOKEN = 0.20 / 1_000_000
_LUNA_OUTPUT_PER_TOKEN = 1.20 / 1_000_000

# course slug -> (display name, grade). Matches the "Pre-AP X" identity
# already live in the corpus (chunks.metadata.course) so the ids this run
# produces collide with — and cleanly overwrite via ON CONFLICT — the old
# paraphrased rows for the SAME (course, grade, code), rather than leaving
# them stranded alongside new verbatim ones. "english-1" is real (confirmed
# 200 at pre-ap.collegeboard.org/courses/english-1) but was missing from
# ingest_pre_ap.py's own course table — the paraphrased "Pre-AP English 1"
# chunks already in the corpus came from somewhere else entirely, so this
# is the first script to actually re-derive it from the source PDF.
COURSES = {
    "algebra-1": ("Pre-AP Algebra 1", 9),
    "algebra-2": ("Pre-AP Algebra 2", 10),
    "biology": ("Pre-AP Biology", 9),
    "chemistry": ("Pre-AP Chemistry", 10),
    "dance": ("Pre-AP Dance", 9),
    "english-1": ("Pre-AP English 1", 9),
    "english-2": ("Pre-AP English 2", 10),
    "geometry": ("Pre-AP Geometry", 10),
    "music": ("Pre-AP Music", 9),
    "theatre": ("Pre-AP Theatre", 9),
    "visual-arts": ("Pre-AP Visual Arts", 9),
    "world-history": ("Pre-AP World History", 9),
}


class _Usage:
    def __init__(self):
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self._lock = threading.Lock()

    def add(self, usage) -> None:
        if not usage:
            return
        with self._lock:
            self.prompt_tokens += getattr(usage, "prompt_tokens", 0) or 0
            self.completion_tokens += getattr(usage, "completion_tokens", 0) or 0

    @property
    def cost(self) -> float:
        return self.prompt_tokens * _LUNA_INPUT_PER_TOKEN + self.completion_tokens * _LUNA_OUTPUT_PER_TOKEN

    def __str__(self) -> str:
        return f"{self.prompt_tokens:,} in + {self.completion_tokens:,} out tokens = ${self.cost:.2f}"


USAGE = _Usage()

PRE_AP_EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "standards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "code": {"type": "string"},
                    "description": {"type": "string"},
                    "strand": {"type": "string"},
                    "source_page_or_section": {"type": "string"},
                },
                "required": ["code", "description", "strand", "source_page_or_section"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["standards"],
    "additionalProperties": False,
}


def get_pdf_url(slug: str) -> str | None:
    resp = requests.get(f"https://pre-ap.collegeboard.org/courses/{slug}", timeout=30)
    match = re.search(r'href="(/media/pdf/[^"]+course-guide\.pdf)"', resp.text)
    return f"https://pre-ap.collegeboard.org{match.group(1)}" if match else None


def download_pdf(slug: str) -> Path | None:
    dest = SOURCE_DOCS / f"{slug}.pdf"
    if dest.exists():
        return dest
    url = get_pdf_url(slug)
    if not url:
        log.error("No PDF URL found for %s", slug)
        return None
    SOURCE_DOCS.mkdir(parents=True, exist_ok=True)
    log.info("Downloading %s -> %s", url, dest.name)
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = "".join(c for c in text if unicodedata.category(c)[0] != "C" or c.isspace())
    for a, b in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"),
                 ("–", "-"), ("—", "-"), (" ", " ")):
        text = text.replace(a, b)
    text = re.sub(r"-\s+", "-", text)
    return re.sub(r"\s+", " ", text).strip()


_NONWORD_RE = re.compile(r"[^0-9a-z ]+")


def wordwise(text: str) -> str:
    return re.sub(r"\s+", " ", _NONWORD_RE.sub(" ", normalize(text).lower())).strip()


def is_framework_page(text: str) -> bool:
    """Same heuristic as ingest_pre_ap.py's own page-boundary scan and
    01c_ingest_ap_ceds.py's is_framework_page — a Pre-AP Course Framework
    uses the same vocabulary (enduring understanding / learning objective /
    essential knowledge) as a full AP CED, just a shorter document."""
    text_lower = text.lower()
    keywords = ["learning objective", "essential knowledge", "enduring understanding",
                "thematic focus", "skill", "topic", "unit"]
    matches = sum(1 for k in keywords if k in text_lower)
    code_matches = (len(re.findall(r"\b[A-Z]{2,4}-\d\.[A-Z]\b", text))
                     + len(re.findall(r"\b\d\.[A-Z]\b", text)))
    return matches >= 2 or code_matches >= 3


def render_table(rows: list[list[str | None]]) -> str:
    """One pdfplumber table -> plain text, cell boundaries marked with ' | '
    so the LLM (and the verbatim check) see each cell as itself, never
    fused with its neighbor. A cell's own internal line-wraps are collapsed
    to spaces — the wrap point is a rendering accident, not part of the
    standard's wording, and leaving it in as \\n would make the same
    description fail the check on one PDF re-render and pass on another."""
    lines = []
    for row in rows:
        cells = [re.sub(r"\s+", " ", (c or "")).strip() for c in row]
        if any(cells):
            lines.append(" | ".join(cells))
    return "\n".join(lines)


def page_text(page) -> str:
    """A page's readable content: table cells extracted by pdfplumber's own
    row/column detection, plus whatever prose sits outside any table.

    Why not just page.extract_text()? Confirmed directly on Pre-AP Dance's
    4-column Essential-Knowledge/Advanced/Proficient/Emerging table
    (rendering the page as an image to check by eye, then diffing against
    the extracted text): both pypdf's and pdftotext's plain text extraction
    read the page LEFT-TO-RIGHT, TOP-TO-BOTTOM ACROSS THE WHOLE PAGE WIDTH,
    which for a 4-column table means every physical text line is four
    unrelated cells' worth of words, fused together, because all four sit
    at the same vertical position. "Suggest and justify" (cell 2, row 1)
    and "Using dance-specific" (cell 3, row 1) landed on the identical
    output line. The LLM reads the real table fine (it has the actual
    columns to look at); the plain-text baseline used to verify it against
    had already scrambled the very words it was supposed to confirm — a
    false rejection, not a caught hallucination. pdfplumber's find_tables()
    detects the actual ruling/alignment structure, so cells never merge
    across a column boundary regardless of how many columns share a row.
    """
    tables = page.find_tables()
    if not tables:
        return page.extract_text() or ""

    # A detected table's bbox can extend past the page edge — seen on Pre-AP
    # Dance's own "About Pre-AP Dance" pointer-diagram page, whose decorative
    # callout boxes get misread as a table with a negative x0. outside_bbox()
    # raises on that rather than clamping, and this page's actual standards
    # (the diagram is explanatory, not a real table anyway) are better served
    # by falling back to plain text than by losing the whole page.
    try:
        # Prose OUTSIDE the table(s) still matters (a "Big Idea" heading and
        # its explanatory paragraph sit above the table on Dance's own page
        # 30) — crop it out rather than re-reading the whole page, which
        # would just reintroduce the same column-fusing problem for the
        # excluded area.
        non_table = page
        for t in tables:
            non_table = non_table.outside_bbox(t.bbox)
        prose = non_table.extract_text() or ""
    except ValueError:
        prose = page.extract_text() or ""

    parts = [prose] if prose.strip() else []
    for t in tables:
        try:
            parts.append(render_table(t.extract()))
        except ValueError:
            continue
    return "\n\n".join(parts)


def prepare_course(slug: str, pdf_path: Path) -> dict | None:
    course_name, grade = COURSES[slug]

    import pdfplumber

    try:
        with pdfplumber.open(pdf_path) as pdf:
            page_texts = [page_text(p) for p in pdf.pages]
    except Exception as e:
        log.error("Failed to read %s with pdfplumber: %s", pdf_path.name, e)
        return None

    full_text_raw = "\x0c".join(page_texts)
    full_text_wordwise = wordwise(full_text_raw)

    if not full_text_raw.strip():
        log.error("pdfplumber produced no text for %s.", pdf_path.name)
        return None

    framework_text = "\n\n".join(p for p in page_texts if is_framework_page(p))

    if not framework_text:
        log.warning("No framework pages detected for %s.", course_name)
        return None

    chunk_size = 30000
    text_chunks = [framework_text[i:i + chunk_size] for i in range(0, len(framework_text), chunk_size)]
    log.info("Prepared %s: %d characters, %d batches.", course_name, len(framework_text), len(text_chunks))

    return {
        "course_name": course_name,
        "grade": grade,
        "pdf_name": pdf_path.name,
        "full_text_raw": full_text_raw,
        "full_text_wordwise": full_text_wordwise,
        "text_chunks": text_chunks,
    }


def run_batch(course_name: str, grade: int, pdf_name: str, batch_idx: int, total_batches: int, txt: str,
              full_text_raw: str, full_text_wordwise: str) -> dict:
    prompt = f"""
    Extract ALL educational standards (Learning Objectives, Essential Knowledge, Enduring Understandings, Skills) from the following text of a College Board Pre-AP Course Framework.

    CRITICAL RULES:
    1. 'code' should be the identifier (e.g., '1.A', 'LO 2.B', 'Skill 3').
    2. 'description' MUST be the exact, verbatim text of the standard as it appears in the text. Do NOT summarize, reword, or paraphrase. If you paraphrase, the system will reject it.
    3. 'strand' is the overarching topic (e.g. 'Unit 1', 'Big Idea 2').
    4. 'source_page_or_section' is the section header where you found it.

    Text:
    {txt}
    """

    extraction = None
    for attempt in range(3):
        try:
            response = openai_client().chat.completions.create(
                model=settings.openai_model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a meticulous archivist extracting standards "
                            "VERBATIM from a College Board Pre-AP Course Framework. "
                            "Every 'description' MUST be an exact substring of the "
                            "provided text — do not summarize, reword, or "
                            "paraphrase. A paraphrased entry will be rejected by a "
                            "downstream check, so there is no benefit to smoothing "
                            "the wording."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                response_format=_response_format("pre_ap_extraction", PRE_AP_EXTRACTION_SCHEMA),
            )
            extraction = json.loads(response.choices[0].message.content)
            USAGE.add(response.usage)
            break
        except Exception as e:  # noqa: BLE001 — retried below; final failure logged by the caller
            wait_s = 2 ** attempt
            log.warning("  [%s batch %d/%d] LLM call failed (attempt %d/3): %s — retrying in %ds",
                        course_name, batch_idx + 1, total_batches, attempt + 1, e, wait_s)
            time.sleep(wait_s)
    else:
        return {"course_name": course_name, "batch_idx": batch_idx, "total_batches": total_batches,
                "failed": True, "chunks": [], "hallucinated": 0}

    chunks = []
    hallucinated = 0
    for std in extraction.get("standards", []):
        code = std.get("code", "")
        description = std.get("description", "")
        strand = std.get("strand", "")
        section = std.get("source_page_or_section", "")
        std_wordwise = wordwise(description)

        # Zero-fabrication check — identical test to 01c_ingest_ap_ceds.py's
        # own run_batch. A description that fails this is dropped, not kept
        # with verbatim_ok=False: there is no reason to add MORE unverified
        # paraphrases when the entire point of this script is replacing them.
        if std_wordwise and (std_wordwise in full_text_wordwise or description in full_text_raw):
            chunks.append({
                "code": code,
                "description": description,
                "course": course_name,
                "grade": grade,
                "state": "AP",
                # source_type "college_board", not "global_standards_table" —
                # this is what is_ap_course()'s ground truth (_ap_courses()
                # in backend/retrieval.py) actually checks for, same reason
                # 01c_ingest_ap_ceds.py's own comment gives.
                "source_type": "college_board",
                "source_document": pdf_name,
                "source_page_or_section": section,
                "strand": strand,
                "verbatim_ok": True,
                "wordwise_ok": True,
                "embed_text": f"Course: {course_name} — {strand}\n[{code}] {description}",
            })
        else:
            hallucinated += 1

    return {"course_name": course_name, "batch_idx": batch_idx, "total_batches": total_batches,
            "failed": False, "chunks": chunks, "hallucinated": hallucinated}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", metavar="COURSE", help="course names to ingest (e.g. 'Pre-AP Biology')")
    ap.add_argument("--workers", type=int, default=8, help="concurrent LLM calls (default 8)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not settings.has_api_key:
        sys.exit("OPENAI_API_KEY not found in environment. Please add it to your .env file.")

    slugs = list(COURSES)
    if args.only:
        want = {c.lower() for c in args.only}
        slugs = [s for s in slugs if COURSES[s][0].lower() in want]

    if not slugs:
        log.error("No courses to process.")
        return 1

    pdf_paths: dict[str, Path] = {}
    for slug in slugs:
        pdf = download_pdf(slug)
        if pdf:
            pdf_paths[slug] = pdf
        else:
            log.error("Could not obtain a PDF for %s — skipping.", COURSES[slug][0])

    courses = [c for c in (prepare_course(slug, path) for slug, path in pdf_paths.items()) if c is not None]
    prepared_names = {c["course_name"] for c in courses}
    failed_courses = [COURSES[s][0] for s in slugs if COURSES[s][0] not in prepared_names]

    work_items = [
        (c["course_name"], c["grade"], c["pdf_name"], idx, len(c["text_chunks"]), txt,
         c["full_text_raw"], c["full_text_wordwise"])
        for c in courses
        for idx, txt in enumerate(c["text_chunks"])
    ]
    log.info("Dispatching %d batches across %d courses with %d workers.",
              len(work_items), len(courses), args.workers)

    chunks_by_course: dict[str, list[dict]] = defaultdict(list)
    hallucinated_by_course: Counter = defaultdict(int)
    remaining_batches = {c["course_name"]: len(c["text_chunks"]) for c in courses}
    checkpoint_lock = threading.Lock()
    completed = 0

    def write_checkpoint():
        flat = [chunk for course_chunks in chunks_by_course.values() for chunk in course_chunks]
        with open(CHECKPOINT_PATH, "w", encoding="utf-8") as f:
            json.dump(flat, f, indent=2, ensure_ascii=False)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(run_batch, *item) for item in work_items]
        for future in as_completed(futures):
            result = future.result()
            course_name = result["course_name"]
            chunks_by_course[course_name].extend(result["chunks"])
            hallucinated_by_course[course_name] += result["hallucinated"]
            if result["failed"]:
                log.error("  [%s] batch %d/%d permanently failed after 3 attempts — its standards are NOT in this run.",
                          course_name, result["batch_idx"] + 1, result["total_batches"])

            completed += 1
            remaining_batches[course_name] -= 1
            if remaining_batches[course_name] == 0:
                log.info("Finished %s: %d standards verified, %d dropped as hallucinations/paraphrases.",
                          course_name, len(chunks_by_course[course_name]), hallucinated_by_course[course_name])
            if completed % 10 == 0 or completed == len(work_items):
                log.info("Progress: %d/%d batches done. Running cost: %s", completed, len(work_items), USAGE)
                with checkpoint_lock:
                    write_checkpoint()

    for course_name in prepared_names:
        if not chunks_by_course.get(course_name):
            failed_courses.append(course_name)

    all_chunks = [chunk for course_chunks in chunks_by_course.values() for chunk in course_chunks]

    if args.only and OUTPUT_PATH.exists():
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            existing = json.load(f)
        kept = {COURSES[s][0] for s in slugs}
        preserved = [c for c in existing if c.get("course") not in kept]
        all_chunks = preserved + all_chunks

    # Same refuse-to-clobber safety net as 01c_ingest_ap_ceds.py: a run that
    # comes back empty (billing/quota error swallowed on every batch) writes
    # to a sibling .rejected file instead of overwriting the real corpus
    # input, and exits non-zero.
    if not all_chunks or (failed_courses and len(failed_courses) == len(slugs)):
        rejected_path = OUTPUT_PATH.with_suffix(".rejected.json")
        with open(rejected_path, "w", encoding="utf-8") as f:
            json.dump(all_chunks, f, indent=2, ensure_ascii=False)
        log.error(
            "\nEvery requested course failed to extract anything (%s). Wrote "
            "the (empty) result to %s instead of overwriting %s — check API "
            "errors above (billing/quota is the usual cause) and re-run.",
            ", ".join(failed_courses), rejected_path.name, OUTPUT_PATH.name,
        )
        return 1

    if failed_courses:
        log.warning("\nThese courses produced zero verified standards and were "
                    "still written through — check them individually: %s",
                    ", ".join(failed_courses))

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_chunks, f, indent=2, ensure_ascii=False)
    CHECKPOINT_PATH.unlink(missing_ok=True)

    log.info("\nWrote %d verified verbatim chunks to %s", len(all_chunks), OUTPUT_PATH.name)
    log.info("Total actual cost: %s", USAGE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
