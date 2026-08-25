import requests

url = "http://127.0.0.1:8000/api/standards/global/upload"
files = {'file': ('pre-ap-english-1.pdf', open('pre-ap-english-1.pdf', 'rb'), 'application/pdf')}
data = {
    'state': 'Pre-AP',
    'subject': 'English 1',
    'grade': '9'
}

# we need an auth token or bypass.
# But wait, we can just call the internal python functions.
import sys
sys.path.append(".")
from backend.routes.standards import upload_global_standards
import asyncio

# Actually, the llm extraction uses `gpt-5.6-luna`. We can just run it using the python api.

