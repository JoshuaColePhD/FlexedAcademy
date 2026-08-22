#!/usr/bin/env python3
import json
from collections import defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CHUNKS_PATH = PROJECT_ROOT / "data" / "processed" / "alcos_chunks.json"
OUTPUT_REPORT = PROJECT_ROOT / "data" / "processed" / "alcos_audit_report.md"

def main():
    print("Loading ALCOS chunks...")
    with open(CHUNKS_PATH, 'r', encoding='utf-8') as f:
        chunks = json.load(f)

    report = ["# ALCOS Standards Audit Report\n"]
    
    # 1. Check Missing Fields
    missing_fields = defaultdict(int)
    required = ['code', 'description', 'course', 'grade', 'case_framework']
    
    for chunk in chunks:
        for r in required:
            if not chunk.get(r):
                missing_fields[r] += 1

    report.append("## Field Integrity")
    report.append(f"- **Total Chunks:** {len(chunks)}")
    for r in required:
        report.append(f"- **Missing `{r}`:** {missing_fields[r]}")
    report.append("")

    # 2. Check Duplications and Subject Coverage
    unique_entries = set()
    framework_counts = defaultdict(int)
    for c in chunks:
        fw = c.get('case_framework', 'Unknown Framework')
        framework_counts[fw] += 1
        unique_entries.add((c.get('code'), c.get('description'), fw))

    report.append("## Coverage by Framework (CASE API)")
    report.append("| Framework | Total Entries |")
    report.append("|---|---|")
    for fw, count in sorted(framework_counts.items()):
        report.append(f"| {fw} | {count} |")
    
    report.append(f"\n- **Unique (Code, Description, Framework) combinations:** {len(unique_entries)} out of {len(chunks)} total chunks.")

    with open(OUTPUT_REPORT, 'w', encoding='utf-8') as f:
        f.write("\n".join(report))
    
    print(f"Report written to {OUTPUT_REPORT}")

if __name__ == "__main__":
    main()
