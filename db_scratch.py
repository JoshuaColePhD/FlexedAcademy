import os
import sys

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.db import _rows
rows = _rows("SELECT id, quiz_json FROM quizzes ORDER BY created_at DESC LIMIT 1", ())
print("ROWS:", rows)
