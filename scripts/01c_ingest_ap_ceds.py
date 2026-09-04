#!/usr/bin/env python3
"""
Step 1c — Ingest AP Course and Exam Descriptions (CEDs) into the chunk schema.

This script parses the College Board AP CED PDFs located in `data/raw/source_docs/`.
Because each of the 39 AP courses uses a wildly different layout for its Course Framework,
this script uses a chunked LLM extraction pipeline coupled with STRICT zero-fabrication 
verification against the local PDF.

Usage:
    python scripts/01c_ingest_ap_ceds.py                 # all AP courses
    python scripts/01c_ingest_ap_ceds.py --only "AP Biology" "AP US History"
"""

import argparse
import hashlib
import json
import logging
import re
import subprocess
import sys
import threading
import time
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
import pypdf

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import settings  # noqa: E402
from backend.llm import client as openai_client, _response_format  # noqa: E402

SOURCE_DOCS = PROJECT_ROOT / "data" / "raw" / "source_docs"
OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "ap_chunks.json"
CHECKPOINT_PATH = PROJECT_ROOT / "data" / "processed" / "ap_chunks.partial.json"

log = logging.getLogger("ap_ceds")

# gpt-5.6-luna standard-tier, short-context pricing (developers.openai.com/api/docs/pricing,
# checked 2026-08-22). Our ~30k-char (~8k-token) batches never approach a
# long-context threshold, so short-context is the right tier throughout.
_LUNA_INPUT_PER_TOKEN = 0.20 / 1_000_000
_LUNA_OUTPUT_PER_TOKEN = 1.20 / 1_000_000


class _Usage:
    """Running token/cost tally across the whole run, updated after every real
    API response (not estimated) — so 'how much did this cost' has an actual
    answer instead of a projection."""

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
        return (f"{self.prompt_tokens:,} in + {self.completion_tokens:,} out tokens "
                f"= ${self.cost:.2f}")


USAGE = _Usage()

# Same shape as backend/llm.py's STANDARDS_EXTRACTION_SCHEMA, plus the two
# fields this pipeline also wants (strand, source_page_or_section) that the
# state-standards extractor doesn't need.
AP_CED_EXTRACTION_SCHEMA = {
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

# Exact course identities already used throughout the app (backend/retrieval.py's
# _COURSE_ALIASES/_SHARED_VARIANTS, the eval suites, SUBJECT_LABELS). A naive
# filename->Title Case conversion produces names that don't match these — e.g.
# it would split the two AP Physics C PDFs into two different courses instead
# of the one "AP Physics C" the rest of the app already keys on, and spell "AP
# US Government & Politics" as "and" instead of "&". Wrong here means every
# course-identity fix from 2026-08-22 has to be re-derived for nothing.
_FILENAME_TO_COURSE = {
    "ap-comparative-government-and-politics-course-and-exam-description.pdf": "AP Comparative Government and Politics",
    "ap-biology-course-and-exam-description.pdf": "AP Biology",
    "ap-us-history-course-and-exam-description.pdf": "AP US History",
    "ap-english-language-and-composition-course-and-exam-description.pdf": "AP English Language and Composition",
    "ap-german-language-and-culture-course-and-exam-description.pdf": "AP German Language and Culture",
    "ap-music-theory-course-and-exam-description.pdf": "AP Music Theory",
    "ap-art-and-design-course-and-exam-description.pdf": "AP Art and Design",
    "ap-precalculus-course-and-exam-description.pdf": "AP Precalculus",
    "ap-latin-course-and-exam-description.pdf": "AP Latin",
    "ap-chinese-language-and-culture-course-and-exam-description.pdf": "AP Chinese Language and Culture",
    "ap-spanish-language-and-culture-course-and-exam-description.pdf": "AP Spanish Language and Culture",
    "ap-computer-science-principles-course-and-exam-description.pdf": "AP Computer Science Principles",
    "ap-english-literature-and-composition-course-and-exam-description.pdf": "AP English Literature and Composition",
    "ap-physics-c-mechanics-course-and-exam-description.pdf": "AP Physics C",
    "ap-physics-c-electricity-and-magnetism-course-and-exam-description.pdf": "AP Physics C",
    "ap-seminar-course-and-exam-description.pdf": "AP Seminar",
    "ap-japanese-language-and-culture-course-and-exam-description.pdf": "AP Japanese Language and Culture",
    "ap-art-history-course-and-exam-description.pdf": "AP Art History",
    "ap-statistics-course-and-exam-description.pdf": "AP Statistics",
    "ap-macroeconomics-course-and-exam-description.pdf": "AP Macroeconomics",
    "ap-african-american-studies-course-and-exam-description.pdf": "AP African American Studies",
    "ap-italian-language-and-culture-course-and-exam-description.pdf": "AP Italian Language and Culture",
    "ap-cybersecurity-course-and-exam-description.pdf": "AP Cybersecurity",
    "ap-microeconomics-course-and-exam-description.pdf": "AP Microeconomics",
    "ap-physics-2-course-and-exam-description.pdf": "AP Physics 2",
    "ap-environmental-science-course-and-exam-description.pdf": "AP Environmental Science",
    "ap-psychology-course-and-exam-description.pdf": "AP Psychology",
    "ap-research-course-and-exam-description.pdf": "AP Research",
    "ap-calculus-ab-and-bc-course-and-exam-description.pdf": "AP Calculus AB & BC",
    "ap-french-language-and-culture-course-and-exam-description.pdf": "AP French Language and Culture",
    "ap-world-history-modern-course-and-exam-description.pdf": "AP World History",
    "ap-spanish-literature-and-culture-course-and-exam-description.pdf": "AP Spanish Literature and Culture",
    "ap-business-personal-finance-course-and-exam-description.pdf": "AP Business & Personal Finance",
    "ap-computer-science-a-course-and-exam-description.pdf": "AP Computer Science A",
    "ap-european-history-course-and-exam-description.pdf": "AP European History",
    "ap-human-geography-course-and-exam-description.pdf": "AP Human Geography",
    "ap-chemistry-course-and-exam-description.pdf": "AP Chemistry",
    "ap-physics-1-course-and-exam-description.pdf": "AP Physics 1",
    "ap-us-government-and-politics-course-and-exam-description.pdf": "AP US Government & Politics",
}


def get_course_name_from_filename(filename: str) -> str:
    if filename in _FILENAME_TO_COURSE:
        return _FILENAME_TO_COURSE[filename]
    # Do not guess. A new College Board PDF must be explicitly mapped so it
    # cannot create an orphan course identity that retrieval silently excludes.
    raise ValueError(
        f"{filename} has no entry in _FILENAME_TO_COURSE; add the official "
        "course identity before ingesting it"
    )

def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = "".join(c for c in text if unicodedata.category(c)[0] != "C" or c.isspace())
    for a, b in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"),
                 ("–", "-"), ("—", "-"), (" ", " ")):
        text = text.replace(a, b)
    text = re.sub(r"-\s+", "-", text)
    return re.sub(r"\s+", " ", text).strip()

_NONWORD_RE = re.compile(r"[^0-9a-z ]+")

def wordwise(text: str) -> str:
    return re.sub(r"\s+", " ", _NONWORD_RE.sub(" ", normalize(text).lower())).strip()

def is_framework_page(text: str) -> bool:
    # Heuristics to identify pages containing standards rather than fluff
    text_lower = text.lower()
    keywords = ["learning objective", "essential knowledge", "enduring understanding", "thematic focus", "skill", "topic", "unit"]
    matches = sum(1 for k in keywords if k in text_lower)
    
    # Check for typical AP codes like "IST-1.A.1", "1.A", "2.B.1"
    code_matches = len(re.findall(r"\b[A-Z]{2,4}-\d\.[A-Z]\b", text)) + len(re.findall(r"\b\d\.[A-Z]\b", text))
    
    return matches >= 2 or code_matches >= 3

def extract_pdf_text_pdftotext(pdf: Path) -> str:
    try:
        res = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], check=True, capture_output=True, text=True)
        return res.stdout
    except subprocess.CalledProcessError as exc:
        log.warning("pdftotext failed on %s: %s", pdf.name, exc.stderr.strip()[:200])
        return ""

def prepare_course(pdf_path: Path) -> dict | None:
    """Everything local/CPU-bound: pdftotext, page filtering, batching. No API
    calls, so this stays cheap and sequential — the API calls it feeds are
    what gets parallelized in main()."""
    course_name = get_course_name_from_filename(pdf_path.name)
    source_pdf_sha256 = hashlib.sha256(pdf_path.read_bytes()).hexdigest()

    full_text_raw = extract_pdf_text_pdftotext(pdf_path)
    full_text_wordwise = wordwise(full_text_raw)

    framework_text = ""
    try:
        with open(pdf_path, "rb") as f:
            reader = pypdf.PdfReader(f)
            for page in reader.pages:
                page_text = page.extract_text() or ""
                if is_framework_page(page_text):
                    framework_text += page_text + "\n\n"
    except Exception as e:
        log.error("Failed to read pages for %s: %s", pdf_path.name, e)
        return None

    if not framework_text:
        log.warning("No framework pages detected for %s.", course_name)
        return None

    chunk_size = 30000
    text_chunks = [framework_text[i:i + chunk_size] for i in range(0, len(framework_text), chunk_size)]
    log.info("Prepared %s: %d characters, %d batches.", course_name, len(framework_text), len(text_chunks))

    return {
        "course_name": course_name,
        "pdf_name": pdf_path.name,
        "full_text_raw": full_text_raw,
        "full_text_wordwise": full_text_wordwise,
        "text_chunks": text_chunks,
        "source_pdf_sha256": source_pdf_sha256,
        "source_version": f"sha256:{source_pdf_sha256}",
    }


def run_batch(course_name: str, pdf_name: str, batch_idx: int, total_batches: int, txt: str,
              full_text_raw: str, full_text_wordwise: str, source_pdf_sha256: str,
              source_version: str) -> dict:
    """One LLM call plus its zero-fabrication verification. Pure with respect
    to everything except USAGE (its own lock) — safe to run in a thread pool."""
    prompt = f"""
    Extract ALL educational standards (Learning Objectives, Essential Knowledge, Enduring Understandings, Skills) from the following text of an AP Course and Exam Description.

    CRITICAL RULES:
    1. 'code' should be the identifier (e.g., 'IST-1.A', '1.A', 'Skill 2.A').
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
                            "VERBATIM from an AP Course and Exam Description. Every "
                            "'description' MUST be an exact substring of the "
                            "provided text — do not summarize, reword, or "
                            "paraphrase. A paraphrased entry will be rejected by a "
                            "downstream check, so there is no benefit to smoothing "
                            "the wording."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                response_format=_response_format("ap_ced_extraction", AP_CED_EXTRACTION_SCHEMA),
                # gpt-5.6-luna only supports the default temperature (1) —
                # passing 0 (what every other batch-extraction script here
                # uses) 400s on every call. Determinism instead comes from
                # the strict JSON schema plus the zero-fabrication check below.
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

        # Zero-fabrication check
        if std_wordwise and (std_wordwise in full_text_wordwise or description in full_text_raw):
            chunks.append({
                "code": code,
                "description": description,
                "course": course_name,
                "grade": 11,  # Default high school grade
                "state": "AP",
                # Every other AP chunk in the corpus uses "college_board" —
                # it's what is_ap_course()'s ground truth (_ap_courses()
                # in backend/retrieval.py) actually checks for. Writing
                # "ap_standards" here would silently un-recognize every
                # AP course this script touches.
                "source_type": "college_board",
                "source_document": pdf_name,
                "source_pdf_sha256": source_pdf_sha256,
                "source_version": source_version,
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
    ap.add_argument("--only", nargs="*", metavar="COURSE", help="course names to ingest (e.g. 'AP Biology')")
    ap.add_argument("--workers", type=int, default=8, help="concurrent LLM calls (default 8)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not settings.has_api_key:
        sys.exit("OPENAI_API_KEY not found in environment. Please add it to your .env file.")

    pdfs = [f for f in SOURCE_DOCS.glob("ap-*.pdf")]

    if args.only:
        want = {c.lower() for c in args.only}
        pdfs = [f for f in pdfs if get_course_name_from_filename(f.name).lower() in want]

    if not pdfs:
        log.error("No PDFs found to process.")
        return 1

    # Local/CPU-bound prep stays sequential (it's fast — no API calls); every
    # batch across every course is then flattened into ONE work queue so a
    # 27-batch course (AP US History) doesn't become a serial tail behind
    # workers idling on courses that finished early.
    courses = [c for c in (prepare_course(p) for p in pdfs) if c is not None]
    prepared_names = {c["course_name"] for c in courses}
    failed_courses = [get_course_name_from_filename(p.name) for p in pdfs
                       if get_course_name_from_filename(p.name) not in prepared_names]

    work_items = [
        (c["course_name"], c["pdf_name"], idx, len(c["text_chunks"]), txt,
         c["full_text_raw"], c["full_text_wordwise"], c["source_pdf_sha256"],
         c["source_version"])
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

    # Append or overwrite? For now, if --only, we should append/update.
    # But since this is a clean rebuild, we can just overwrite if it's the full run.
    if args.only and OUTPUT_PATH.exists():
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            existing = json.load(f)
        kept = {get_course_name_from_filename(p.name) for p in pdfs}
        preserved = [c for c in existing if c.get("course") not in kept]
        all_chunks = preserved + all_chunks

    # This exact failure mode (a billing/quota error on every batch, caught
    # and logged, run finishes "successfully" with 0 chunks, that empty
    # result gets written straight over the real corpus) is what emptied this
    # file the last time this script ran. Refuse to repeat it: a full run
    # that comes back with nothing, or an --only run where every named course
    # came back empty, writes to a sibling .rejected file instead of
    # clobbering the real output, and exits non-zero.
    if not all_chunks or (failed_courses and len(failed_courses) == len(pdfs)):
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

    log.info("\nWrote %d chunks to %s", len(all_chunks), OUTPUT_PATH.name)
    log.info("Total actual cost: %s", USAGE)
    return 0

if __name__ == "__main__":
    sys.exit(main())
