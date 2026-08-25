import sys
sys.path.append(".")
from pypdf import PdfReader
from backend.llm import extract_standards_from_text
from backend import db

pdf = PdfReader("pre-ap-english-1-course-guide.pdf")
text_pages = []
for page in pdf.pages:
    text_pages.append(page.extract_text())
full_text = "\n".join(filter(None, text_pages))

print(f"Extracted {len(full_text)} chars from PDF. Calling LLM...")
standards = extract_standards_from_text(full_text)
print(f"Got {len(standards)} standards. Inserting...")
db.insert_global_standards("default_user", "Pre-AP", "English 1", "9", standards)
print("Done!")
