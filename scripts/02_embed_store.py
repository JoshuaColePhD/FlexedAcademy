#!/usr/bin/env python3
"""
Step 2 — Embed and store the parsed standards in a local vector database.

This uses a local ChromaDB instance and sentence-transformers to keep everything 
on-machine for Phase 1. The metadata schema is preserved so that in Phase 2 
we can easily filter by course/state/grade.
"""

import json
import sys
from pathlib import Path
import chromadb
from chromadb.utils import embedding_functions

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CHUNKS_PATH = PROJECT_ROOT / "chunks.json"
DB_PATH = PROJECT_ROOT / "chroma_db"
COLLECTION_NAME = "ap_lang_standards"

def main() -> int:
    if not CHUNKS_PATH.exists():
        print(f"Error: {CHUNKS_PATH.name} not found. Run 01_parse_chunks.py first.")
        return 1

    with open(CHUNKS_PATH, "r", encoding="utf-8") as f:
        chunks = json.load(f)

    print(f"Loaded {len(chunks)} chunks from {CHUNKS_PATH.name}.")

    # Initialize ChromaDB persistent client
    print(f"Initializing ChromaDB at {DB_PATH.relative_to(PROJECT_ROOT)}/")
    client = chromadb.PersistentClient(path=str(DB_PATH))
    
    # Use sentence-transformers/all-MiniLM-L6-v2 which is standard and runs locally
    # It will download the model weights on the first run.
    emb_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2"
    )

    # Get or create collection
    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        embedding_function=emb_fn,
        metadata={"description": "AP Lang and Alabama ELA Standards"}
    )
    
    # Prepare data for Chroma
    ids = []
    documents = []
    metadatas = []

    for chunk in chunks:
        # We use the standard's code as its unique ID in the vector store.
        # This makes it easy to update or retrieve a specific standard later.
        ids.append(chunk["code"])
        
        # We embed the composite text that includes structural context (like examples or strands)
        documents.append(chunk["embed_text"])
        
        # We store the rest of the fields as metadata.
        # Chroma requires metadata values to be str, int, float, or bool.
        meta = {}
        for k, v in chunk.items():
            if k not in ["code", "embed_text"]:
                if v is None:
                    continue
                if isinstance(v, list):
                    # Join lists into a single string for Chroma metadata
                    meta[k] = " | ".join(str(item) for item in v)
                else:
                    meta[k] = v
        metadatas.append(meta)

    print("Embedding and storing in Chroma...")
    
    # Upsert allows us to run this script idempotently without duplicating data.
    collection.upsert(
        ids=ids,
        documents=documents,
        metadatas=metadatas
    )

    print(f"Successfully stored {collection.count()} chunks in collection '{COLLECTION_NAME}'.")
    
    # A quick spot-check to prove it worked
    sample_id = ids[0]
    sample = collection.get(ids=[sample_id])
    print("\nSpot-check of first inserted chunk:")
    print(f"  ID: {sample['ids'][0]}")
    print(f"  Metadata snippet: course={sample['metadatas'][0].get('course')}, grade={sample['metadatas'][0].get('grade')}")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
