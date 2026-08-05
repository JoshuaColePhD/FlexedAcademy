from backend.retrieval import retrieve_grounded
res = retrieve_grounded("Create a lesson plan that explores the role of ATP in supporting various processes in biological systems.", subject_code="Science", grade=11)
print([c['metadata']['source_type'] for c in res.chunks])
print([c['metadata']['code'] for c in res.chunks])
