import urllib.request
import json
import sys

key = "p3ZskeDH2XMGYroPDC7CM9PE"
url = "https://api.commonstandardsproject.com/api/v1/standard_sets/C020E45D386948A8B713672688ADCACF"
req = urllib.request.Request(url, headers={"Api-Key": key})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode("utf-8"))
    
    # print the first standard
    st = data["data"]["standards"]
    first_key = list(st.keys())[0]
    print(json.dumps(st[first_key], indent=2))
