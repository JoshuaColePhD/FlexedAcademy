import json
import logging
from pathlib import Path

from backend.config import settings
from backend import db
from backend.retrieval import embed_query

logging.basicConfig(level=logging.INFO)

def main():
    db.connect()
    chunks_path = Path(settings.chunks_path)
    if not chunks_path.exists():
        print(f"Chunks file not found at {chunks_path}")
        return
        
    print("Loading chunks...")
    chunks = []
    # We might have multiple chunk files just like the old logic
    paths = sorted(chunks_path.parent.glob("*chunks.json"))
    for path in paths:
        with open(path, "r", encoding="utf-8") as f:
            chunks.extend(json.load(f))
            
    print(f"Found {len(chunks)} chunks. Generating embeddings and inserting to DB...")
    
    conn = db.connect()
    with conn.cursor() as cur:
        # Clear existing chunks if any
        cur.execute("DELETE FROM chunks")
        
        for i, chunk in enumerate(chunks):
            chunk_id = chunk["id"]
            document = chunk["document"]
            metadata = chunk["metadata"]
            
            # Generate embedding
            embedding = embed_query(document)
            
            cur.execute(
                "INSERT INTO chunks (id, document, metadata, embedding) VALUES (%s, %s, %s, %s)",
                (chunk_id, document, json.dumps(metadata), embedding)
            )
            
            if (i + 1) % 50 == 0:
                print(f"Inserted {i + 1}/{len(chunks)} chunks...")
                
        conn.commit()
    print("Done!")

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    main()
