from backend.retrieval import retrieve_grounded, get_reranker
import logging

logging.basicConfig(level=logging.INFO)

# Prime the reranker
get_reranker()

# Test retrieval
res = retrieve_grounded(
    query="How to write a persuasive essay",
    subject_code="AP_Lang",
    grade=11,
    top_k=5,
)

print("\nRetrieved chunks:")
for c in res.chunks:
    score = c.get('rerank_score', 'N/A')
    dist = c.get('distance', 'N/A')
    print(f"ID: {c['id']}, Score: {score}, Dist: {dist}")
