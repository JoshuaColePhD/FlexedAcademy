# Archive — dead reference material

Folders under `archive/` are **not part of the running FlexedAcademy app**.
Nothing here is imported, built, deployed, or wired into `backend/` or `frontend/`.
They're kept only as historical/reference material because they had no other backup.

## archive/ap-lang-rag-prototype/

An early standalone prototype ("AP Lang RAG Lesson Plan Generator — Phase 1") for
grounding lesson-plan generation in Alabama ELA standards, AP Lang skills, and ACT
English standards. Folded in on 2026-09-12 after confirming FlexedAcademy's live
backend has no functional dependency on it (an earlier egg-info that looked like a
dependency was actually FlexedAcademy's own historical package name, `ap_lang_rag`,
not a reference to this separate project).

Excluded from the copy (regenerable/bulky, not needed for reference):
`venv/`, `frontend/node_modules/`, `chroma_db/`, `AP_LANG_RAG/` (a duplicate of
`source_docs/`), `temp/`, `.git/` (only 2 commits, no GitHub remote — history not
preserved beyond this note).

If anyone ever wants to resume this prototype, treat it as a fresh Phase 1 start:
steps 0–1 (scaffold, source docs) were done; steps 2–6 (embed, retrieve, generate,
eval) were never started. See its own `README.md` in this folder for details.
