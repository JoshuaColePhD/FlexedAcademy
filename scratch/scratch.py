from sentence_transformers import CrossEncoder
try:
    model = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')
    print("CrossEncoder loaded successfully!")
except Exception as e:
    print(f"Error: {e}")
