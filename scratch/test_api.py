import urllib.request
import json
import sys

key = "p3ZskeDH2XMGYroPDC7CM9PE"
url = "https://api.commonstandardsproject.com/api/v1/jurisdictions/B838B98D043045748F3814B9E43CAC85"
req = urllib.request.Request(url, headers={"Api-Key": key})
try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        sets = data["data"].get("standardSets", [])
        for s in sets:
            print(f"{s['id']} | {s['title']} | {s.get('subject', '')}")
except Exception as e:
    print(e)
