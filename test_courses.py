import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from backend import db

def check_courses():
    rows = db._rows("SELECT DISTINCT metadata->>'course' AS course, metadata->>'source_type' AS src FROM chunks")
    courses = {}
    for r in rows:
        c = r['course']
        s = r['src']
        if c not in courses:
            courses[c] = []
        courses[c].append(s)
        
    for c, s_list in sorted(courses.items(), key=lambda x: str(x[0])):
        print(f"{c}: {s_list}")

if __name__ == "__main__":
    check_courses()
