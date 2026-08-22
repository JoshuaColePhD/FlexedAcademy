#!/usr/bin/env python3
"""
Parses the ground-truth ACT standards from data/raw/act-*-standards.md,
maps them to the respective courses, and outputs them as act_chunks.json.

This script ensures zero-fabrication by reading directly from the local ground-truth markdown files.
"""

import json
from pathlib import Path
import re

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = PROJECT_ROOT / "data" / "raw"
OUT_PATH = PROJECT_ROOT / "data" / "processed" / "act_chunks.json"

MAPPINGS = {
    "english": {
        "courses": ["AP_Lang", "ELA"],
        "prefix": "E"
    },
    "math": {
        "courses": ["Math"],
        "prefix": "M"
    },
    "reading": {
        "courses": ["Social_Studies", "AP_Lang", "ELA"],
        "prefix": "R"
    },
    "science": {
        "courses": ["Science"],
        "prefix": "S"
    }
}

ACT_GRADES = (9, 10, 11, 12)

def process_file(path: Path, mapping: dict) -> list:
    print(f"Parsing ACT Standards from {path.name}...")
    
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()
        
    chunks = []
    courses = mapping["courses"]
    prefix = mapping["prefix"]
    
    section = ""
    strand = ""
    score_band = ""
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        if line.startswith("## ") and line != "## Not yet included":
            section = line[3:].strip()
            strand = ""
            score_band = ""
        elif line.startswith("### "):
            strand = line[4:].strip()
            score_band = ""
        elif line.startswith("**") and line.endswith("**"):
            score_band = line.replace("**", "").strip()
        elif line.startswith("- ") and "." in line and section and strand and score_band:
            bullet_text = line[2:] 
            if "." in bullet_text:
                code_raw, desc = bullet_text.split(".", 1)
                code_raw = code_raw.strip()
                desc = desc.strip()
                
                if code_raw.isupper() or any(c.isdigit() for c in code_raw):
                    parts = code_raw.split(" ")
                    if len(parts) == 2:
                        code = f"{prefix}.{parts[0]}.{parts[1]}"
                    else:
                        code = f"{prefix}.{code_raw.replace(' ', '.')}"
                        
                    for course in courses:
                        for grade in ACT_GRADES:
                            chunk = {
                                "code": code,
                                "description": desc,
                                "course": course,
                                "grade": grade,
                                "state": "National",
                                "source_type": "act_standards",
                                "source_document": path.name,
                                "source_page_or_section": f"{section} > {strand}",
                                "strand": strand,
                                "score_band": score_band,
                                "verbatim_ok": True,
                                "embed_text": f"{section} ACT Standard {code}\nStrand: {strand}\nScore Band: {score_band}\n{desc}"
                            }
                            chunks.append(chunk)
                            
    return chunks

def main():
    all_chunks = []
    parsed_count = 0
    
    for subject, mapping in MAPPINGS.items():
        file_path = RAW_DIR / f"act-{subject}-standards.md"
        if file_path.exists():
            chunks = process_file(file_path, mapping)
            all_chunks.extend(chunks)
            unique = len(chunks) // (len(mapping["courses"]) * len(ACT_GRADES))
            parsed_count += unique
            print(f"  -> Parsed {unique} unique standards")
        else:
            print(f"Warning: {file_path.name} not found.")

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_chunks, f, indent=2)
        
    print(f"Parsed {parsed_count} unique standards from markdown across all subjects.")
    print(f"Wrote {len(all_chunks)} chunk permutations to {OUT_PATH.name}")

if __name__ == "__main__":
    main()
