import sys
import json
sys.path.append(".")
from pypdf import PdfReader
from backend.config import settings
from openai import OpenAI
from backend import db
import os

pdf = PdfReader("pre-ap-english-1-course-guide.pdf")

text_pages = []
for i in range(26, 41):
    text_pages.append(pdf.pages[i].extract_text())

full_text = "\n".join(filter(None, text_pages))
print(f"Extracted {len(full_text)} chars from the framework pages. Calling LLM with increased timeout...")

client = OpenAI(api_key=settings.openai_api_key, timeout=300.0)

try:
    response = client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {
                "role": "system",
                "content": "You are a specialized parser. Extract every educational standard from the provided document text. "
                           "Return a strictly formatted JSON array containing the standard 'code' (e.g. OH.BIO.1) and "
                           "the 'description'. Do not omit any standards, and do not include extra commentary."
            },
            {"role": "user", "content": full_text},
        ],
        response_format={"type": "json_schema", "json_schema": {
            "name": "standards_extraction",
            "schema": {
                "type": "object",
                "properties": {
                    "standards": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "code": {"type": "string"},
                                "description": {"type": "string"}
                            },
                            "required": ["code", "description"],
                            "additionalProperties": False
                        }
                    }
                },
                "required": ["standards"],
                "additionalProperties": False
            },
            "strict": True
        }}
    )
    
    content = response.choices[0].message.content
    data = json.loads(content)
    standards = data.get("standards", [])
    print(f"Got {len(standards)} standards. Inserting...")
    db.insert_global_standards("default_user", "Pre-AP", "English 1", "9", standards)
    print("Done!")
except Exception as e:
    print(f"Failed: {e}")

