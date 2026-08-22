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
import json
import logging
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import List

from dotenv import load_dotenv
from google import genai
from pydantic import BaseModel
import pypdf

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DOCS = PROJECT_ROOT / "data" / "raw" / "source_docs"
OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "ap_chunks.json"

log = logging.getLogger("ap_ceds")

def get_course_name_from_filename(filename: str) -> str:
    name = filename.replace("-course-and-exam-description.pdf", "").replace("-", " ").title()
    name = name.replace("Ap ", "AP ")
    name = name.replace("Us ", "US ")
    name = name.replace(" And ", " & ")
    return name

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

class Standard(BaseModel):
    code: str
    description: str
    strand: str
    source_page_or_section: str

class StandardsExtraction(BaseModel):
    standards: List[Standard]

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

def ingest_pdf(pdf_path: Path, client: genai.Client) -> list[dict]:
    course_name = get_course_name_from_filename(pdf_path.name)
    log.info("Processing %s...", course_name)
    
    # 1. Full text for strict verification
    full_text_raw = extract_pdf_text_pdftotext(pdf_path)
    full_text_wordwise = wordwise(full_text_raw)
    
    # 2. Extract pages using pypdf to filter out non-framework fluff
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
        return []
        
    if not framework_text:
        log.warning("No framework pages detected for %s.", course_name)
        return []

    log.info("  Filtered to %d characters of framework text. Calling LLM...", len(framework_text))
    
    chunks = []
    
    # Chunk the framework text into manageable blocks for the LLM
    chunk_size = 30000
    text_chunks = [framework_text[i:i+chunk_size] for i in range(0, len(framework_text), chunk_size)]
    
    verified_count = 0
    hallucinated_count = 0
    
    for idx, txt in enumerate(text_chunks):
        log.info("    Batch %d/%d...", idx+1, len(text_chunks))
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
        
        try:
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
                config=genai.types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=StandardsExtraction,
                    temperature=0.0,
                ),
            )
            
            extraction = response.parsed
            if not extraction:
                continue
                
            for std in extraction.standards:
                std_wordwise = wordwise(std.description)
                
                # Zero-fabrication check
                if std_wordwise in full_text_wordwise or std.description in full_text_raw:
                    chunk = {
                        "code": std.code,
                        "description": std.description,
                        "course": course_name,
                        "grade": 11, # Default high school grade
                        "state": "AP",
                        "source_type": "ap_standards",
                        "source_document": pdf_path.name,
                        "source_page_or_section": std.source_page_or_section,
                        "strand": std.strand,
                        "verbatim_ok": True,
                        "wordwise_ok": True,
                        "embed_text": f"Course: {course_name} — {std.strand}\n[{std.code}] {std.description}"
                    }
                    chunks.append(chunk)
                    verified_count += 1
                else:
                    hallucinated_count += 1
        except Exception as e:
            log.error("    LLM call failed: %s", e)
            
    log.info("  Verified %d standards. Dropped %d hallucinations/paraphrases.", verified_count, hallucinated_count)
    return chunks

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", metavar="COURSE", help="course names to ingest (e.g. 'AP Biology')")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit("GEMINI_API_KEY not found in environment. Please add it to your .env file.")
    client = genai.Client()
        
    pdfs = [f for f in SOURCE_DOCS.glob("ap-*.pdf")]
    
    if args.only:
        want = {c.lower() for c in args.only}
        pdfs = [f for f in pdfs if get_course_name_from_filename(f.name).lower() in want]
        
    if not pdfs:
        log.error("No PDFs found to process.")
        return 1
        
    all_chunks = []
    
    for pdf in pdfs:
        chunks = ingest_pdf(pdf, client)
        all_chunks.extend(chunks)
        
    # Append or overwrite? For now, if --only, we should append/update.
    # But since this is a clean rebuild, we can just overwrite if it's the full run.
    if args.only and OUTPUT_PATH.exists():
        with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
            existing = json.load(f)
        kept = {get_course_name_from_filename(p.name) for p in pdfs}
        preserved = [c for c in existing if c.get("course") not in kept]
        all_chunks = preserved + all_chunks

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_chunks, f, indent=2, ensure_ascii=False)
        
    log.info("\nWrote %d chunks to %s", len(all_chunks), OUTPUT_PATH.name)
    return 0

if __name__ == "__main__":
    sys.exit(main())
