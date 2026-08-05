#!/usr/bin/env python3
"""
Fetch standards for AP Courses from the Common Standards Project API.
"""

from __future__ import annotations

import json
import logging
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import settings

log = logging.getLogger("aplang.fetch")
logging.basicConfig(level=logging.INFO, format="%(message)s")

OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "ap_chunks.json"
BASE_URL = "https://api.commonstandardsproject.com/api/v1"
AP_JURISDICTION_ID = "0A5FD99233A74D8FA3A74F52E5F6CDEC"

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

def build_parent_hierarchy(st_id: str, standards_dict: dict) -> list[str]:
    hierarchy = []
    current = standards_dict.get(st_id)
    while current and current.get("statementNotation"):
        hierarchy.append(current["statementNotation"])
        parent_id = current.get("standardId")
        if not parent_id:
            break
        current = standards_dict.get(parent_id)
    return list(reversed(hierarchy))

def get_parent_code_and_text(st_id: str, standards_dict: dict) -> tuple[str | None, str | None]:
    current = standards_dict.get(st_id)
    if not current: return None, None
    parent_id = current.get("standardId")
    if not parent_id: return None, None
    parent = standards_dict.get(parent_id)
    if not parent: return None, None
    return parent.get("statementNotation"), parent.get("description")

def main():
    if not settings.common_standards_api_key:
        log.error("ERROR: COMMON_STANDARDS_API_KEY is not set.")
        sys.exit(1)

    log.info("Fetching AP standard sets...")
    sets_data = fetch_json(f"{BASE_URL}/jurisdictions/{AP_JURISDICTION_ID}")
    standard_sets = sets_data["data"].get("standardSets", [])
    
    chunks = []
    
    # Filter for valid courses (skip SAT and generic terms if possible)
    for sset in standard_sets:
        title = sset["title"].strip()
        # Clean title for course name
        clean_title = title.split(" (")[0].split(":")[0]
        
        # Skip if not an AP course (some are SAT or generic)
        if "AP" not in clean_title and "Pre-AP" not in clean_title and "Advanced" not in clean_title:
            continue
            
        set_id = sset["id"]
        log.info(f"Fetching: {title} ({set_id})")
        
        try:
            set_details = fetch_json(f"{BASE_URL}/standard_sets/{set_id}")
            standards_dict = set_details["data"]["standards"]
            
            for st_id, st in standards_dict.items():
                if not st.get("statementNotation"):
                    continue
                
                # Check if this standard has children (is just a folder)
                has_children = any(other.get("standardId") == st_id for other in standards_dict.values())
                if has_children:
                    continue
                    
                code = st["statementNotation"]
                desc = st.get("description", "")
                
                hierarchy = build_parent_hierarchy(st_id, standards_dict)
                strand = hierarchy[0] if hierarchy else None
                
                parent_code, parent_text = get_parent_code_and_text(st_id, standards_dict)
                
                embed_text = f"{clean_title} — Grade 11 — {strand or clean_title}\n[{code}] {desc}"
                if parent_text:
                    embed_text += f" (Under: {parent_text})"
                
                chunks.append({
                    "code": code,
                    "description": desc,
                    "course": clean_title,
                    "grade": 11, # Map all AP to 11 for simplicity, so they show up for standard HS grades
                    "state": "AP",
                    "source_type": "college_board",
                    "source_document": f"{title}.pdf",
                    "source_page_or_section": strand,
                    "strand": strand,
                    "mode": None,
                    "domain": None,
                    "sub_skill": None,
                    "score_band": None,
                    "reporting_category": None,
                    "frequency": None,
                    "examples": None,
                    "parent_code": parent_code,
                    "parent_text": parent_text,
                    "notes": [],
                    "item_type": "Standard",
                    "case_framework": title,
                    "case_item_uri": f"{BASE_URL}/standards/{st_id}",
                    "official_source_url": None,
                    "verbatim_ok": True,
                    "wordwise_ok": True,
                    "embed_text": embed_text
                })
        except Exception as e:
            log.error(f"Failed to fetch {title}: {e}")
            
        time.sleep(1) # Be nice to the API
        
    log.info(f"Generated {len(chunks)} chunks.")
    
    with open(OUTPUT_PATH, "w") as f:
        json.dump(chunks, f, indent=2)
        
    log.info(f"Wrote {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
