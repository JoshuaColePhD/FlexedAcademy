"""Shared manifest for the Alabama standards ingestion pipeline."""

from __future__ import annotations

STATE = "AL"

# course, CASE package id, local PDF path relative to the shared standards folder
FRAMEWORKS = (
    ("ELA", "d5af742b-1042-4647-a45a-027e4c4a2f1f", "English Language Arts (2021).pdf"),
    ("Math", "0c01a9eb-4d20-4578-89fb-3876b435c3d4", "Mathematics (2019, rev 2021).pdf"),
    ("Science", "d90c97ad-c327-4799-97bc-37789308baab", "Science (2023).pdf"),
    ("Social_Studies", "5936b8cf-ae38-49ca-aa4c-85707bbdef07", "Social Studies (2024).pdf"),
    ("Arts", "1de51ebf-fdb5-4a4a-bc68-3fab6e6ed7d6", "Arts Education (2024).pdf"),
    ("DLCS", "8ab34547-b2e8-4189-9aad-ea232df02fbd", "Digital Literacy and Computer Science (2025).pdf"),
    ("Health", "2adb1f52-c078-4c1c-b559-62f58832fc68", "Health Education (2019).pdf"),
    ("PE", "98581f63-d6b5-4cad-982e-73c26ff0ff57", "Physical Education (2019).pdf"),
    ("World_Languages", "63b660d5-e540-49ae-84f5-0cd99cdf1eb9", "World Languages (2017).pdf"),
    ("Counseling", "93710213-5d54-4326-b1d5-660a933dd3bd", "Comprehensive School Counseling (2024-2026).pdf"),
    ("Math_AWF", "edd52d0d-4c05-4f4b-bcd4-f51897db339f", "_Superseded/Mathematics - Algebra with Finance (2015).pdf"),
)

FRAMEWORK_IDS = frozenset(course for course, _case_id, _pdf in FRAMEWORKS)
