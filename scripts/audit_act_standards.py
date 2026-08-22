#!/usr/bin/env python3
import json
from collections import defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CHUNKS_PATH = PROJECT_ROOT / "data" / "processed" / "act_chunks.json"
OUTPUT_REPORT = PROJECT_ROOT / "data" / "processed" / "act_audit_report.md"

def main():
    print("Loading ACT chunks...")
    with open(CHUNKS_PATH, 'r', encoding='utf-8') as f:
        chunks = json.load(f)

    report = ["# ACT Standards Audit Report\n"]
    
    # 1. Check Missing Fields
    missing_codes = 0
    missing_desc = 0
    missing_score = 0
    for chunk in chunks:
        if not chunk.get('code'): missing_codes += 1
        if not chunk.get('description'): missing_desc += 1
        if not chunk.get('score_band'): missing_score += 1

    report.append("## Field Integrity")
    report.append(f"- **Total Chunks:** {len(chunks)}")
    report.append(f"- **Missing `code`:** {missing_codes}")
    report.append(f"- **Missing `description`:** {missing_desc}")
    report.append(f"- **Missing `score_band`:** {missing_score}\n")

    # 2. Check Duplications and Subject Coverage
    # We expect some duplicates across grades for ACT because score bands cover multiple grades.
    # Let's count unique (code, description, grade)
    unique_entries = set()
    subject_counts = defaultdict(int)
    for c in chunks:
        subject = c.get('course', 'Unknown')
        subject_counts[subject] += 1
        unique_entries.add((c.get('code'), c.get('description'), c.get('grade')))

    report.append("## Coverage by Subject")
    report.append("| Subject | Total Entries |")
    report.append("|---|---|")
    for subj, count in subject_counts.items():
        report.append(f"| {subj} | {count} |")
    
    report.append(f"\n- **Unique (Code, Description, Grade) combinations:** {len(unique_entries)} out of {len(chunks)} total chunks.")

    with open(OUTPUT_REPORT, 'w', encoding='utf-8') as f:
        f.write("\n".join(report))
    
    print(f"Report written to {OUTPUT_REPORT}")

if __name__ == "__main__":
    main()
