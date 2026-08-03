#!/usr/bin/env python3
"""
Step 3 — Retrieval
Connects to the local ChromaDB and provides a function to query the standards.
Also includes a set of tests to evaluate retrieval quality.
"""

from pathlib import Path
import chromadb
from chromadb.utils import embedding_functions

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "chroma_db"
COLLECTION_NAME = "ap_lang_standards"

def get_collection():
    """Initializes and returns the ChromaDB collection."""
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Database not found at {DB_PATH}. Run 02_embed_store.py first.")
        
    # We set Settings(anonymized_telemetry=False) to avoid warnings if desired, 
    # but defaults are fine for this proof of concept.
    client = chromadb.PersistentClient(path=str(DB_PATH))
    emb_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2"
    )
    collection = client.get_collection(name=COLLECTION_NAME, embedding_function=emb_fn)
    return collection

def retrieve(query: str, top_k: int = 5) -> list[dict]:
    """Retrieve the top_k most relevant standard chunks for a given query."""
    collection = get_collection()
    
    # Query the collection
    results = collection.query(
        query_texts=[query],
        n_results=top_k,
        include=["documents", "metadatas", "distances"]
    )
    
    # Format the results into a list of dictionaries
    retrieved = []
    for i in range(len(results["ids"][0])):
        retrieved.append({
            "id": results["ids"][0][i],
            "document": results["documents"][0][i],
            "metadata": results["metadatas"][0][i],
            "distance": results["distances"][0][i]
        })
        
    return retrieved

def run_tests():
    """Test retrieval against realistic teacher queries."""
    queries = [
        "I need a lesson plan about analyzing rhetorical choices in a speech.",
        "We are reading a poem and I want to test their grammar and sentence structure.",
        "Students are struggling with synthesizing evidence from multiple sources for an argument.",
        "I want students to collaborate on a digital presentation."
    ]
    
    for query in queries:
        print(f"\n{'='*80}\nQUERY: {query}\n{'-'*80}")
        results = retrieve(query, top_k=3)
        for i, res in enumerate(results, 1):
            doc = res["document"]
            # truncate document for cleaner output
            doc_short = (doc[:200] + "...") if len(doc) > 200 else doc
            # Convert newlines to spaces for tighter terminal output
            doc_short = doc_short.replace("\n", " ")
            print(f"{i}. [{res['id']}] (Dist: {res['distance']:.3f})\n   {doc_short}\n")

if __name__ == "__main__":
    run_tests()
