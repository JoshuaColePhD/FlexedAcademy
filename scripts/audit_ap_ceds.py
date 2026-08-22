#!/usr/bin/env python3
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import pypdf

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_DOCS = PROJECT_ROOT / "data" / "raw" / "source_docs"
CHUNKS_PATH = PROJECT_ROOT / "data" / "processed" / "ap_chunks.json"
OUTPUT_REPORT = PROJECT_ROOT / "data" / "processed" / "ap_audit_report.md"

_FILENAME_TO_COURSE = {
    "ap-comparative-government-and-politics-course-and-exam-description.pdf": "AP Comparative Government and Politics",
    "ap-biology-course-and-exam-description.pdf": "AP Biology",
    "ap-us-history-course-and-exam-description.pdf": "AP US History",
    "ap-english-language-and-composition-course-and-exam-description.pdf": "AP English Language and Composition",
    "ap-german-language-and-culture-course-and-exam-description.pdf": "AP German Language and Culture",
    "ap-music-theory-course-and-exam-description.pdf": "AP Music Theory",
    "ap-art-and-design-course-and-exam-description.pdf": "AP Art and Design",
    "ap-precalculus-course-and-exam-description.pdf": "AP Precalculus",
    "ap-latin-course-and-exam-description.pdf": "AP Latin",
    "ap-chinese-language-and-culture-course-and-exam-description.pdf": "AP Chinese Language and Culture",
    "ap-spanish-language-and-culture-course-and-exam-description.pdf": "AP Spanish Language and Culture",
    "ap-computer-science-principles-course-and-exam-description.pdf": "AP Computer Science Principles",
    "ap-english-literature-and-composition-course-and-exam-description.pdf": "AP English Literature and Composition",
    "ap-physics-c-mechanics-course-and-exam-description.pdf": "AP Physics C",
    "ap-physics-c-electricity-and-magnetism-course-and-exam-description.pdf": "AP Physics C",
    "ap-seminar-course-and-exam-description.pdf": "AP Seminar",
    "ap-japanese-language-and-culture-course-and-exam-description.pdf": "AP Japanese Language and Culture",
    "ap-art-history-course-and-exam-description.pdf": "AP Art History",
    "ap-statistics-course-and-exam-description.pdf": "AP Statistics",
    "ap-macroeconomics-course-and-exam-description.pdf": "AP Macroeconomics",
    "ap-african-american-studies-course-and-exam-description.pdf": "AP African American Studies",
    "ap-italian-language-and-culture-course-and-exam-description.pdf": "AP Italian Language and Culture",
    "ap-cybersecurity-course-and-exam-description.pdf": "AP Cybersecurity",
    "ap-microeconomics-course-and-exam-description.pdf": "AP Microeconomics",
    "ap-physics-2-course-and-exam-description.pdf": "AP Physics 2",
    "ap-environmental-science-course-and-exam-description.pdf": "AP Environmental Science",
    "ap-psychology-course-and-exam-description.pdf": "AP Psychology",
    "ap-research-course-and-exam-description.pdf": "AP Research",
    "ap-calculus-ab-and-bc-course-and-exam-description.pdf": "AP Calculus AB & BC",
    "ap-french-language-and-culture-course-and-exam-description.pdf": "AP French Language and Culture",
    "ap-world-history-modern-course-and-exam-description.pdf": "AP World History",
    "ap-spanish-literature-and-culture-course-and-exam-description.pdf": "AP Spanish Literature and Culture",
    "ap-business-personal-finance-course-and-exam-description.pdf": "AP Business & Personal Finance",
    "ap-computer-science-a-course-and-exam-description.pdf": "AP Computer Science A",
    "ap-european-history-course-and-exam-description.pdf": "AP European History",
    "ap-human-geography-course-and-exam-description.pdf": "AP Human Geography",
    "ap-chemistry-course-and-exam-description.pdf": "AP Chemistry",
    "ap-physics-1-course-and-exam-description.pdf": "AP Physics 1",
    "ap-us-government-and-politics-course-and-exam-description.pdf": "AP US Government & Politics",
}

def main():
    print("Loading chunks...")
    with open(CHUNKS_PATH, 'r', encoding='utf-8') as f:
        all_chunks = json.load(f)

    chunks_by_course = defaultdict(list)
    for c in all_chunks:
        chunks_by_course[c.get('course')].append(c)

    report_lines = []
    report_lines.append("# AP Standards Audit Report\n")
    report_lines.append("## Coverage Table\n")
    report_lines.append("| Course | PDF Estimate | Chunks Stored | Ratio | Status |")
    report_lines.append("|---|---|---|---|---|")

    fix_list = []

    print("Analyzing PDFs...")
    for pdf_file in SOURCE_DOCS.glob("ap-*.pdf"):
        course_name = _FILENAME_TO_COURSE.get(pdf_file.name)
        if not course_name:
            continue
        
        print(f"Checking {course_name} ({pdf_file.name})...")
        
        pdf_text = ""
        try:
            with open(pdf_file, 'rb') as f:
                reader = pypdf.PdfReader(f)
                for page in reader.pages:
                    text = page.extract_text()
                    if text:
                        pdf_text += text + "\n"
        except Exception as e:
            print(f"Failed to read {pdf_file.name}: {e}")
            continue

        course_chunks = chunks_by_course.get(course_name, [])
        num_chunks = len(course_chunks)

        # Basic heuristic to estimate number of standard codes in the PDF
        # We look for patterns like IST-1.A.1, 1.A, Skill 2.A
        code_matches = re.findall(r'\b[A-Z]{2,4}-\d\.[A-Z](?:\.\d)?\b', pdf_text)
        code_matches += re.findall(r'\bSkill \d\.[A-Z]\b', pdf_text)
        
        unique_estimated = len(set(code_matches))
        if unique_estimated == 0:
            unique_estimated = max(1, num_chunks) # Avoid div by zero for subjects that don't use short codes

        ratio = num_chunks / unique_estimated if unique_estimated else 0
        
        status = "✅ Clean"
        if ratio < 0.5:
            status = "⚠️ Needs re-ingest"
            fix_list.append(f"**{course_name}**: Low coverage ({num_chunks} stored vs {unique_estimated} estimated codes).")
        
        report_lines.append(f"| {course_name} | {unique_estimated} | {num_chunks} | {ratio:.2f} | {status} |")

    report_lines.append("\n## Prioritized Fix List\n")
    if fix_list:
        for fix in fix_list:
            report_lines.append(f"- {fix}")
    else:
        report_lines.append("- No critical coverage gaps found beyond known ones.")

    with open(OUTPUT_REPORT, 'w', encoding='utf-8') as f:
        f.write("\n".join(report_lines))
        
    print(f"Report written to {OUTPUT_REPORT}")

if __name__ == "__main__":
    main()
