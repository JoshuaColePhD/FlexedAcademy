import re

with open("scripts/02_embed_store.py", "r") as f:
    code = f.read()

# Replace chromadb stuff
code = code.replace("import chromadb\nfrom chromadb.utils import embedding_functions\n", "")

main_pg = """
    print(f"\\nPostgreSQL Database configured in settings.")
    from backend import db
    from backend.retrieval import get_embedding_model

    conn = db.connect()
    
    if not args.upsert:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM chunks")
            conn.commit()
            print("Dropped existing chunks.")

    print(f"Embedding {len(ids)} chunks...")
    model = get_embedding_model()
    
    with conn.cursor() as cur:
        for start in range(0, len(ids), BATCH_SIZE):
            end = min(start + BATCH_SIZE, len(ids))
            print(f"  {start}-{end}")
            
            batch_ids = ids[start:end]
            batch_docs = documents[start:end]
            batch_metas = metadatas[start:end]
            
            # Embed batch
            batch_embs = model.encode(batch_docs).tolist()
            
            from psycopg2.extras import execute_values
            import json
            
            # Use execute_values for fast insert
            values = []
            for i, d, m, e in zip(batch_ids, batch_docs, batch_metas, batch_embs):
                values.append((i, d, json.dumps(m), e))
                
            execute_values(
                cur,
                "INSERT INTO chunks (id, document, metadata, embedding) VALUES %s ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding",
                values
            )
            conn.commit()
            
        cur.execute("SELECT COUNT(*) FROM chunks")
        final = cur.fetchone()["count"]
        
    print(f"\\nStored {final} chunks in PostgreSQL 'chunks' table.")
"""
code = re.sub(r'    print\(f"\\nChromaDB at \{DB_PATH.name\}/"\).*?(?=\n    sample = )', main_pg, code, flags=re.DOTALL)

with open("scripts/02_embed_store_pg.py", "w") as f:
    f.write(code)

import os
os.replace("scripts/02_embed_store_pg.py", "scripts/02_embed_store.py")
