import urllib.request
import json
import sys

from pathlib import Path
sys.path.insert(0, str(Path(".").resolve()))
from backend.config import settings

url = "https://api.commonstandardsproject.com/api/v1/jurisdictions"
req = urllib.request.Request(url, headers={"Api-Key": settings.common_standards_api_key, "Accept": "application/json"})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode("utf-8"))

for j in data["data"]:
    if "college" in j["title"].lower() or "advanced placement" in j["title"].lower() or "ap " in j["title"].lower():
        print(j["title"], j["id"])
