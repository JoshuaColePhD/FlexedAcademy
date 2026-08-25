import sys
sys.path.append(".")
from backend import db

rows = db._rows("SELECT subject, COUNT(*) as count FROM global_standards GROUP BY subject ORDER BY subject")
print("Standards in DB by Subject:")
for r in rows:
    print(f"- {r['subject']}: {r['count']}")

total = sum(r['count'] for r in rows)
print(f"\nTotal standards: {total}")
