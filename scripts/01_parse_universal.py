#!/usr/bin/env python3
"""
Step 1b — Universal LLM Parser for PDFs

Reads all PDFs in `source_docs/universal/`.
Extracts educational standards using OpenAI Structured Outputs.
Enforces the strict rule: every extracted standard MUST be found verbatim in the raw PDF text.

Outputs: universal_chunks.json
"""

import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from pydantic import BaseModel
from typing import List, Optional
from openai import OpenAI

from dotenv import load_dotenv
load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DOCS = PROJECT_ROOT / "data" / "raw" / "universal"
OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "universal_chunks.json"

# We must have poppler installed
if subprocess.run(["which", "pdftotext"], capture_output=True).returncode != 0:
    sys.exit("pdftotext not found. Install poppler: brew install poppler")

def pdftotext(pdf: Path) -> str:
    cmd = ["pdftotext", str(pdf), "-"]
    try:
        res = subprocess.run(cmd, check=True, capture_output=True, text=True)
        return res.stdout
    except subprocess.CalledProcessError as exc:
        sys.exit(f"pdftotext failed on {pdf.name}: {exc.stderr}")

def normalize_whitespace(text: str) -> str:
    # Same normalizer used in the main parser
    text = "".join(c for c in text if unicodedata.category(c)[0] != "C" or c.isspace())
    text = text.replace('"', '"').replace('"', '"')
    text = text.replace("'", "'").replace("'", "'")
    text = text.replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text).strip()

class Standard(BaseModel):
    code: str
    description: str
    strand: str
    source_page_or_section: str

class StandardsExtraction(BaseModel):
    course: str
    grade: int
    state: str
    standards: List[Standard]

def main():
    if not SOURCE_DOCS.exists():
        SOURCE_DOCS.mkdir(parents=True, exist_ok=True)
        print(f"Created {SOURCE_DOCS}. Drop PDFs here to parse.")
        return

    pdfs = list(SOURCE_DOCS.glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs found in {SOURCE_DOCS}.")
        return

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    if not client.api_key:
        sys.exit("OPENAI_API_KEY not found in environment.")

    all_chunks = []

    for pdf in pdfs:
        print(f"\nProcessing {pdf.name}...")
        raw_text = pdftotext(pdf)
        norm_raw_text = normalize_whitespace(raw_text)

        # To avoid hitting max tokens, we process in chunks if the PDF is huge, 
        # but for now we assume the user provides targeted PDFs (e.g. 5-10 pages).
        if len(raw_text) > 200000:
            print(f"Warning: {pdf.name} is very large. Consider splitting it.")

        prompt = f"""
        You are an expert curriculum parser. Extract ALL educational standards from the following text.
        
        Rules:
        1. 'code' should be the identifier (e.g., 'M.1', '2.a').
        2. 'description' MUST be the exact, verbatim text of the standard. Do not paraphrase. Do not alter punctuation.
        3. 'strand' is the overarching topic (e.g. 'Algebra', 'Life Sciences').
        4. 'source_page_or_section' is the section header or page number where you found it.
        
        Text:
        {raw_text[:100000]} # Limiting to 100k chars for safety, assuming small targeted PDFs
        """

        print("  Calling OpenAI...")
        completion = client.beta.chat.completions.parse(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": "You are a precise data extraction tool."},
                {"role": "user", "content": prompt},
            ],
            response_format=StandardsExtraction,
            temperature=0.0
        )

        extraction = completion.choices[0].message.parsed
        if not extraction:
            print("  Failed to parse.")
            continue

        print(f"  Extracted {len(extraction.standards)} standards. Verifying verbatim...")
        
        verified_count = 0
        for std in extraction.standards:
            norm_desc = normalize_whitespace(std.description)
            if norm_desc in norm_raw_text:
                chunk = {
                    "code": std.code,
                    "description": std.description,
                    "course": extraction.course,
                    "grade": extraction.grade,
                    "state": extraction.state,
                    "source_type": "state_course_of_study",
                    "source_document": pdf.name,
                    "source_page_or_section": std.source_page_or_section,
                    "strand": std.strand,
                    "verbatim_ok": True,
                    "embed_text": f"Course: {extraction.course}\nStrand: {std.strand}\nCode: {std.code}\n{std.description}"
                }
                all_chunks.append(chunk)
                verified_count += 1
            else:
                print(f"  [ERROR] Hallucination detected! Could not find verbatim: '{std.description[:50]}...'")

        print(f"  Verified {verified_count}/{len(extraction.standards)} standards.")

    if all_chunks:
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            json.dump(all_chunks, f, indent=2)
        print(f"\nWrote {len(all_chunks)} chunks to {OUTPUT_PATH.name}")
        print("Run `02_embed_store.py` to add these to the database.")

if __name__ == "__main__":
    main()
