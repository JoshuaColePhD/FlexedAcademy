import sys
sys.path.append(".")
from backend import db

sql = """
CREATE TABLE IF NOT EXISTS global_standards (
    state TEXT,
    subject TEXT,
    grade TEXT,
    code TEXT,
    description TEXT,
    created_by TEXT,
    created_at TEXT,
    UNIQUE(state, subject, grade, code)
);
"""

# run the SQL directly
db._write(sql, ())
print("Table created.")

