#!/usr/bin/env python3
"""
Step 1 (Alternative) — Fetch standards from the Common Standards Project API.

Instead of parsing raw PDFs, this script queries the Common Standards Project API
(a CASE-compliant JSON database) to retrieve all Alabama standards for a given subject.

Usage:
    python scripts/01_fetch_case_api.py
"""

from __future__ import annotations

import json
import logging
import sys
import urllib.request
import urllib.error
from pathlib import Path

# Add project root to sys.path so we can import backend config
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import settings

log = logging.getLogger("aplang.fetch")
logging.basicConfig(level=logging.INFO, format="%(message)s")

OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "chunks.json"
BASE_URL = "https://api.commonstandardsproject.com/api/v1"

def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={
        "Api-Key": settings.common_standards_api_key,
        "Accept": "application/json"
    })
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        log.error(f"HTTP Error {e.code}: {e.reason} for {url}")
        sys.exit(1)

def main():
    if not settings.common_standards_api_key:
        log.error("ERROR: COMMON_STANDARDS_API_KEY is not set in your .env file.")
        log.error("Please sign up at https://commonstandardsproject.com to get a free API key.")
        sys.exit(1)

    log.info("Connecting to Common Standards Project API...")
    
    jurisdictions = fetch_json(f"{BASE_URL}/jurisdictions")
    alabama = next((j for j in jurisdictions["data"] if j["title"] == "Alabama"), None)
    
    if not alabama:
        log.error("Could not find Alabama in the jurisdictions list.")
        sys.exit(1)
        
    log.info(f"Found Alabama Jurisdiction ID: {alabama['id']}")
    
    # 2. Fetch standard_sets for Alabama
    sets_data = fetch_json(f"{BASE_URL}/jurisdictions/{alabama['id']}")
    standard_sets = sets_data["data"].get("standardSets", [])
    
    target_subjects = {"Mathematics", "Science", "Social Studies", "English Language Arts"}
    
    chunks = []
    
    for sset in standard_sets:
        subject = sset.get("subject", "")
        # The subject strings often contain year suffixes like "Science (2015)"
        clean_subject = subject.split(" (")[0]
        if clean_subject not in target_subjects:
            continue
            
        set_id = sset["id"]
        title = sset["title"]
        log.info(f"Fetching standard set: {title} ({clean_subject})")
        
        try:
            set_details = fetch_json(f"{BASE_URL}/standard_sets/{set_id}")
            standards_dict = set_details["data"]["standards"]
            
            # Map grade from title (e.g. "Grade 11: ...")
            # This is a naive extraction; ideally we handle multiple grades or K
            grade_val = 99
            if "Grade " in title:
                g_str = title.split("Grade ")[1].split(":")[0].split()[0]
                if g_str.isdigit():
                    grade_val = int(g_str)
            elif "Kindergarten" in title:
                grade_val = 0
            elif "Grades " in title:
                g_str = title.split("Grades ")[1].split("-")[0]
                if g_str.isdigit():
                    grade_val = int(g_str)
                    
            for st_id, st in standards_dict.items():
                if not st.get("statementNotation"):
                    continue
                
                # Fetch parent text for context if possible
                parent_text = ""
                parent_id = st.get("parentId")
                if parent_id and parent_id in standards_dict:
                    parent_text = standards_dict[parent_id].get("description", "")
                    
                chunk = {
                    "code": st["statementNotation"],
                    "description": st["description"],
                    "course": clean_subject.replace(" ", "_"),
                    "grade": grade_val,
                    "state": "AL",
                    "source_type": "case_api",
                    "source_document": f"CASE_{set_id}",
                    "source_page_or_section": title,
                    "strand": None,
                    "mode": None,
                    "domain": None,
                    "sub_skill": None,
                    "score_band": None,
                    "reporting_category": None,
                    "frequency": None,
                    "examples": None,
                    "parent_code": standards_dict.get(parent_id, {}).get("statementNotation") if parent_id else None,
                    "parent_text": parent_text,
                    "notes": [],
                    "embed_text": f"[{st['statementNotation']}] {st['description']}" + (f" (Under: {parent_text})" if parent_text else ""),
                    "verbatim_ok": True
                }
                chunks.append(chunk)
                
        except Exception as e:
            log.error(f"Failed to fetch set {set_id}: {e}")
            
    log.info(f"Writing {len(chunks)} chunks to {OUTPUT_PATH}")
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(chunks, f, indent=2)
        
    log.info("Done! You can now run python scripts/02_embed_store.py to vectorize them.")

if __name__ == "__main__":
    main()
