import sys
import os
import json

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from backend.retrieval import retrieve_raw

COURSES = [
    "ELA",
    "Math",
    "Science",
    "Social_Studies",
    "Arts",
    "Counseling",
    "DLCS",
    "Health",
    "PE",
    "World_Languages",
]

GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

def validate():
    print("=== Quality Check for All Courses and Grades ===")
    
    results_summary = []
    
    for course in COURSES:
        for grade in GRADES:
            query = "Introduction to the main concepts, fundamentals, and general overview"
            results = retrieve_raw(query, n=5, course=course, grade=str(grade))
            
            if not results:
                results_summary.append({
                    "course": course,
                    "grade": grade,
                    "status": "NO_STANDARDS_FOUND"
                })
                continue
                
            invalid_standards = []
            valid_standards = 0
            
            for r in results:
                meta = r.get("metadata", {})
                retrieved_grade = str(meta.get("grade", "N/A"))
                retrieved_course = meta.get("course", "UNKNOWN")
                
                # Check if the retrieved standard matches the requested grade
                # Note: Some standards might apply to a range of grades (e.g., "9-12")
                # We'll do a simple substring check or exact match
                if str(grade) in retrieved_grade or retrieved_grade in ["9-12", "K-12"] or (grade == 0 and retrieved_grade == "K"):
                    valid_standards += 1
                else:
                    # In some cases, the metadata might use "K" instead of "0"
                    # Or "9-12" instead of "9", "10", "11", "12"
                    invalid_standards.append({
                        "id": r.get("id"),
                        "retrieved_grade": retrieved_grade,
                        "retrieved_course": retrieved_course,
                        "code": meta.get("code")
                    })
                    
            if invalid_standards:
                results_summary.append({
                    "course": course,
                    "grade": grade,
                    "status": "MISMATCH",
                    "invalid_count": len(invalid_standards),
                    "valid_count": valid_standards,
                    "invalid_samples": invalid_standards[:2]
                })
            else:
                results_summary.append({
                    "course": course,
                    "grade": grade,
                    "status": "OK",
                    "valid_count": valid_standards
                })

    print(json.dumps(results_summary, indent=2))

if __name__ == "__main__":
    validate()
