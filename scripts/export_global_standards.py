import sys
import json
sys.path.append(".")
from backend import db

# Fetch all global standards
rows = db._rows("SELECT * FROM global_standards")

chunks = []
for row in rows:
    subject_name = row["subject"]
    # Add prefix if not there so it shows up beautifully in the dropdown
    course_name = subject_name if subject_name.startswith("Pre-AP") else f"Pre-AP {subject_name}"
    
    chunks.append({
        "code": row["code"],
        "description": row["description"],
        "course": course_name,
        "grade": int(row["grade"]) if row["grade"].isdigit() else row["grade"],
        "state": row["state"],
        "source_type": "global_standards_table",
        "source_document": "CollegeBoard",
        "source_page_or_section": "Course Framework",
        "strand": row["subject"],
        "mode": None,
        "domain": None,
        "sub_skill": None,
        "score_band": None,
        "reporting_category": None,
        "frequency": None,
        "examples": None,
        "parent_code": None,
        "parent_text": None,
    })

output_path = "data/processed/pre_ap_chunks.json"
with open(output_path, "w") as f:
    json.dump(chunks, f, indent=2)

print(f"Exported {len(chunks)} standards with Pre-AP prefix to {output_path}")
