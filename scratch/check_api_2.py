import urllib.request
import json
import sys

from pathlib import Path
sys.path.insert(0, str(Path(".").resolve()))
from backend.config import settings

url = "https://api.commonstandardsproject.com/api/v1/jurisdictions/0A5FD99233A74D8FA3A74F52E5F6CDEC"
req = urllib.request.Request(url, headers={"Api-Key": settings.common_standards_api_key, "Accept": "application/json"})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode("utf-8"))

for s in data["data"].get("standardSets", []):
    print(s["title"], s["id"])
