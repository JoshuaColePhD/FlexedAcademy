#!/usr/bin/env python3
import json
import re
from pathlib import Path
import pypdf

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DOCS = PROJECT_ROOT / "data" / "raw" / "source_docs"
OUTPUT_SCRATCH = PROJECT_ROOT / "data" / "processed" / "ap_scratch_messy.json"

TARGETS = {
    "AP Comparative Government and Politics": "ap-comparative-government-and-politics-course-and-exam-description.pdf",
    "AP Computer Science Principles": "ap-computer-science-principles-course-and-exam-description.pdf",
    "AP Microeconomics": "ap-microeconomics-course-and-exam-description.pdf"
}

def extract_from_pdf(pdf_path, course_name):
    print(f"Extracting {course_name}...")
    pdf_text = ""
    try:
        with open(pdf_path, 'rb') as f:
            reader = pypdf.PdfReader(f)
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    pdf_text += text + "\n"
    except Exception as e:
        print(f"Error reading {pdf_path}: {e}")
        return []

    # Regex to find codes like IST-1.A or Skill 2.A
    pattern = r'\b([A-Z]{2,4}-\d\.[A-Z](?:\.\d)?|Skill \d\.[A-Z])\b'
    
    matches = list(re.finditer(pattern, pdf_text))
    chunks = []
    
    for i, match in enumerate(matches):
        code = match.group(1)
        start_idx = match.end()
        # Grab up to the next match or 500 characters max
        if i + 1 < len(matches):
            end_idx = matches[i+1].start()
        else:
            end_idx = start_idx + 500
            
        messy_text = pdf_text[start_idx:end_idx].strip()
        # Clean up whitespace and newlines just a bit for the agent
        messy_text = re.sub(r'\s+', ' ', messy_text)[:400] 
        
        chunks.append({
            "code": code,
            "description": messy_text,
            "course": course_name,
            "grade": 11,
            "state": "AP",
            "source_type": "college_board",
            "source_document": TARGETS[course_name],
            "source_page_or_section": "Unknown",
            "strand": "Unknown",
            "verbatim_ok": False,
            "wordwise_ok": False,
            "embed_text": f"Course: {course_name} — Unknown\n[{code}] {messy_text}"
        })
        
    return chunks

def main():
    all_chunks = []
    for course_name, filename in TARGETS.items():
        pdf_path = SOURCE_DOCS / filename
        chunks = extract_from_pdf(pdf_path, course_name)
        all_chunks.extend(chunks)
        print(f"Found {len(chunks)} messy standards for {course_name}")
        
    with open(OUTPUT_SCRATCH, 'w', encoding='utf-8') as f:
        json.dump(all_chunks, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(all_chunks)} messy chunks to {OUTPUT_SCRATCH}")

if __name__ == "__main__":
    main()
