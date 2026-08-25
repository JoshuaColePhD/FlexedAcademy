import sys
import json
import requests
import re
import os
import traceback
sys.path.append(".")
from pypdf import PdfReader
from backend.config import settings
from openai import OpenAI
from backend import db

client = OpenAI(api_key=settings.openai_api_key, timeout=300.0)

courses = {
    "algebra-1": {"subject": "Algebra 1", "grade": "9"},
    "algebra-2": {"subject": "Algebra 2", "grade": "10"},
    "biology": {"subject": "Biology", "grade": "9"},
    "chemistry": {"subject": "Chemistry", "grade": "10"},
    "dance": {"subject": "Dance", "grade": "9"},
    "english-2": {"subject": "English 2", "grade": "10"},
    "geometry": {"subject": "Geometry", "grade": "10"},
    "music": {"subject": "Music", "grade": "9"},
    "theatre": {"subject": "Theatre", "grade": "9"},
    "visual-arts": {"subject": "Visual Arts", "grade": "9"},
    "world-history": {"subject": "World History", "grade": "9"}
}

def get_pdf_url(course):
    resp = requests.get(f"https://pre-ap.collegeboard.org/courses/{course}")
    match = re.search(r'href="(/media/pdf/[^"]+course-guide\.pdf)"', resp.text)
    if match:
        return f"https://pre-ap.collegeboard.org{match.group(1)}"
    return None

for course_key, metadata in courses.items():
    print(f"\nProcessing {metadata['subject']}...")
    pdf_url = get_pdf_url(course_key)
    
    if not pdf_url:
        print(f"  Failed to find PDF URL for {course_key}")
        continue
        
    print(f"  Downloading {pdf_url}...")
    pdf_path = f"/tmp/{course_key}.pdf"
    with open(pdf_path, 'wb') as f:
        f.write(requests.get(pdf_url).content)
        
    pdf = PdfReader(pdf_path)
    
    # Heuristic to find pages
    start_page = -1
    end_page = -1
    
    for i, page in enumerate(pdf.pages):
        # Skip table of contents (usually first 15 pages)
        if i < 15:
            continue
            
        text = page.extract_text().lower()
        if not text:
            continue
            
        if start_page == -1 and ("enduring understanding" in text or "learning objective" in text or "essential knowledge" in text):
            start_page = i
            
        if start_page != -1 and i > start_page and ("assessments for learning" in text or "support features in model lessons" in text or "sample assessment" in text):
            end_page = i
            break
            
    if end_page == -1:
        end_page = len(pdf.pages)
        
    if start_page == -1:
        print(f"  Could not identify framework pages for {course_key}! Dumping entire PDF (risky).")
        start_page = 0
        end_page = len(pdf.pages)
        
    print(f"  Extracting pages {start_page} to {end_page}...")
    
    text_pages = []
    for i in range(start_page, end_page):
        text_pages.append(pdf.pages[i].extract_text())
        
    full_text = "\n".join(filter(None, text_pages))
    
    if not full_text.strip():
        print("  Empty text. Skipping.")
        continue
        
    print(f"  Sending {len(full_text)} chars to LLM...")
    try:
        response = client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {
                    "role": "system",
                    "content": "You are a specialized parser. Extract every educational standard from the provided document text. "
                               "Return a strictly formatted JSON array containing the standard 'code' (e.g. OH.BIO.1 or RHS-1A or 4.B) and "
                               "the 'description'. Do not omit any standards, and do not include extra commentary."
                },
                {"role": "user", "content": full_text[:40000]}, # Hard cap just in case to prevent timeout
            ],
            response_format={"type": "json_schema", "json_schema": {
                "name": "standards_extraction",
                "schema": {
                    "type": "object",
                    "properties": {
                        "standards": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "code": {"type": "string"},
                                    "description": {"type": "string"}
                                },
                                "required": ["code", "description"],
                                "additionalProperties": False
                            }
                        }
                    },
                    "required": ["standards"],
                    "additionalProperties": False
                },
                "strict": True
            }}
        )
        
        content = response.choices[0].message.content
        data = json.loads(content)
        standards = data.get("standards", [])
        print(f"  Parsed {len(standards)} standards. Saving to DB...")
        db.insert_global_standards("default_user", "Pre-AP", metadata["subject"], metadata["grade"], standards)
        print("  Done!")
    except Exception as e:
        print(f"  Failed: {e}")
        traceback.print_exc()

print("\nAll done!")
