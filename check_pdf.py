from pypdf import PdfReader

reader = PdfReader("pre-ap-english-1-course-guide.pdf")
print(f"Total pages: {len(reader.pages)}")

# Print a tiny snippet from each page to see what they contain
for i, page in enumerate(reader.pages):
    text = page.extract_text()
    if text:
        text = text.replace('\n', ' ')
        if "standard" in text.lower() or "learning objective" in text.lower():
            print(f"Page {i+1}: {text[:100]}...")

