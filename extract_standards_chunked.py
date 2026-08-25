import sys
sys.path.append(".")
from pypdf import PdfReader
from backend.llm import extract_standards_from_text
from backend import db

pdf = PdfReader("pre-ap-english-1-course-guide.pdf")

# Extract text only from the framework pages (27 to 40 - 0-indexed: 26 to 40)
text_pages = []
for i in range(26, 41):
    text_pages.append(pdf.pages[i].extract_text())

full_text = "\n".join(filter(None, text_pages))

print(f"Extracted {len(full_text)} chars from the framework pages. Calling LLM...")
standards = extract_standards_from_text(full_text)
print(f"Got {len(standards)} standards. Inserting...")
db.insert_global_standards("default_user", "Pre-AP", "English 1", "9", standards)
print("Done!")
