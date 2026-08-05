#!/usr/bin/env python3
"""
Downloads the ACT Standards from the provided Google Sheet CSV, maps them 
to the respective courses, and outputs them as act_chunks.json.
"""

import csv
import json
import urllib.request
from collections import Counter
from pathlib import Path

SHEET_URL = "https://docs.google.com/spreadsheets/d/1jZGqNgxTbvWZQLc7pYPUgi9C-DtUlk1M8QK1lJWF1tA/export?format=csv"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = PROJECT_ROOT / "data" / "processed" / "act_chunks.json"

def main():
    print("Downloading ACT Standards CSV...")
    req = urllib.request.Request(SHEET_URL)
    try:
        with urllib.request.urlopen(req) as response:
            lines = [line.decode('utf-8') for line in response.readlines()]
    except Exception as e:
        print(f"Failed to download CSV: {e}")
        return
        
    reader = csv.DictReader(lines)

    chunks = []
    skipped = Counter()

    # Map the CSV's 'Section' onto the canonical course codes.
    #
    # These MUST be the same codes the ALCOS ingest writes (see
    # 01d_ingest_alcos_case.py FRAMEWORKS) and the same ids /api/frameworks hands
    # the Subject Framework dropdown. They previously read
    # "English_Language_Arts"/"Mathematics", which matched nothing: retrieval
    # filters on the selected framework's id, so picking "English Language Arts"
    # (ELA) found zero ACT standards, and the two orphan codes showed up in the
    # dropdown as separate near-empty frameworks. ACT Writing had its own
    # "Writing" course, which is not a framework at all.
    course_map = {
        "English": ["AP_Lang", "ELA"],
        "Reading": ["AP_Lang", "ELA"],
        "Writing": ["AP_Lang", "ELA"],
        "Math": ["Math"],
        "Science": ["Science"],
    }

    # The district lesson-plan template has an ACT Alignment row for every high
    # school course, so these need to be groundable at any high school grade.
    #
    # This replaces a [11, 99] fan-out. 99 was meant as "generic high school", but
    # retrieval filters `grade == <selected grade>` and no teacher can select 99,
    # so every 99 row was unreachable — half the ACT corpus embedded twice and
    # half of that dead. Grade 9-12 is both reachable and true: students sit the
    # ACT in grade 11, and the standards are taught across high school.
    ACT_GRADES = (9, 10, 11, 12)


    for row in reader:
        section = row.get("Section", "").strip()
        desc = row.get("Skill Description", "").strip()
        code = row.get("Standard Code", "").strip()
        strand = row.get("Strand Name", "").strip()
        score_band = row.get("Score Band", "").strip()
        
        if not code or not desc:
            continue
            
        courses = course_map.get(section)
        if not courses:
            skipped[section] += 1
            continue

        for course in courses:
            for grade in ACT_GRADES:
                chunk = {
                    "code": code,
                    "description": desc,
                    "course": course,
                    "grade": grade,
                    "state": "National",
                    "source_type": "act_standards",
                    "source_document": "ACT_Standards_Sheet",
                    "source_page_or_section": section,
                    "strand": strand,
                    "score_band": score_band,
                    "verbatim_ok": True,
                    "embed_text": f"{section} ACT Standard {code}\nStrand: {strand}\nScore Band: {score_band}\n{desc}"
                }
                chunks.append(chunk)
            
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(chunks, f, indent=2)
        
    print(f"Wrote {len(chunks)} chunks to {OUT_PATH.name}")
    if skipped:
        # Named, not silent: an unmapped section is ACT content we are dropping.
        print("Skipped unmapped CSV sections:", dict(skipped))

if __name__ == "__main__":
    main()
