import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from backend.retrieval import retrieve_raw

TEST_CLASSES = [
    {"course": "World_Languages", "grade": 9, "query": "vocabulary conjugation communication"},
    {"course": "AP Spanish Language and Culture", "grade": 12, "query": "communication culture grammar"}
]

def validate():
    print("=== Foreign Languages Class Validation ===")
    
    for tc in TEST_CLASSES:
        course = tc["course"]
        grade = tc["grade"]
        query = tc["query"]
        
        print(f"\n--- Testing Class: {course} (Grade {grade}) ---")
        results = retrieve_raw(query, n=10, course=course, grade=grade)
        
        if not results:
            print("No standards found.")
            continue
            
        summary = {}
        for r in results:
            meta = r.get("metadata", {})
            src = meta.get("source_type", "UNKNOWN")
            c_grade = meta.get("grade", "N/A")
            code = meta.get("code", "UNKNOWN")
            
            key = (src, c_grade)
            if key not in summary:
                summary[key] = []
            summary[key].append(code)
            
        for (src, c_grade), codes in summary.items():
            print(f"- Source: {src} | Grade in DB: {c_grade} | Found {len(codes)} standards (e.g. {codes[0]})")

if __name__ == "__main__":
    validate()
