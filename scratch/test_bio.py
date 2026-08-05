import chromadb
from backend.config import settings
client = chromadb.PersistentClient(path=str(settings.chroma_dir))
coll = client.get_collection("aplang_standards")
print(coll.count())
results = coll.get(where={"course": "AP Biology"})
print(len(results["ids"]))
results2 = coll.get(where={"course": "AP_Biology"})
print(len(results2["ids"]))
