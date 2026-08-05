import re

with open("backend/retrieval.py", "r") as f:
    code = f.read()

# I will write the python script to replace the chromadb logic with psycopg2 + pgvector
