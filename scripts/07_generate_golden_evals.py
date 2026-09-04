"""Generate a current-corpus golden evaluation dataset.

Selects standards from the current Postgres-backed corpus, collapses raw course
variants to the app's canonical identity, and asks the configured model for one
realistic teacher phrasing per course. The historical golden_cases.json remains
untouched; this writes current_golden_cases.json so corpus drift is visible.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import retrieval
from backend.config import settings
from backend.llm import client


def main():
    if not settings.has_api_key:
        print("Error: OPENAI_API_KEY required for synthetic dataset generation.")
        sys.exit(1)

    print("Loading all chunks from backend...")
    all_chunks = retrieval.load_chunks()
    
    # Group by course
    by_course = {}
    for c in all_chunks:
        course = c.get("course")
        if not course:
            continue
        by_course.setdefault(course, []).append(c)

    print(f"Found {len(by_course)} distinct courses/frameworks.")

    golden_cases = []

    # One case per canonical course keeps this set broad and cheap. Prefer a
    # longer description whose code is unique within that course: those are
    # better retrieval probes than bare codes or sibling one-character codes.
    import random
    random.seed(42)

    by_identity = defaultdict(list)
    for course, chunks in by_course.items():
        by_identity[retrieval.normalize_course(course)].extend(chunks)

    preferred_courses = {
        "AP_Lang", "ELA", "Math", "Math_AWF", "Science", "Social_Studies", "Arts",
        "DLCS", "Health", "PE", "World_Languages", "Counseling",
    }

    for identity, chunks in sorted(by_identity.items()):
        raw_courses = sorted({c.get("course") for c in chunks if c.get("course")})
        course = next((name for name in raw_courses if name in preferred_courses), None)
        if course is None:
            # For AP/Pre-AP identities the ordinary source title is already the
            # selectable course key; prefer the shortest raw value to avoid
            # publication-suffix variants such as "Key Concepts 2019-2020".
            course = min(raw_courses, key=lambda name: (len(name), name))
        code_counts = {}
        for chunk in chunks:
            code_counts[chunk.get("code")] = code_counts.get(chunk.get("code"), 0) + 1
        candidates = [c for c in chunks if c.get("description") and code_counts.get(c.get("code")) == 1]
        candidates.sort(key=lambda c: len(c.get("description", "")), reverse=True)
        sample = random.sample(candidates[: min(12, len(candidates))], 1) if candidates else random.sample(chunks, 1)
        for c in sample:
            code = c.get("code") or c.get("id")
            text = c.get("description", "")
            
            prompt = (
                f"You are simulating a teacher planning a lesson. "
                f"They need to teach this standard: {text}\n\n"
                f"Generate a single, natural 1-sentence prompt they would type into a lesson planner "
                f"to request a lesson plan on this topic. Do not mention standard codes, just the content."
            )
            
            try:
                resp = client().chat.completions.create(
                    model=settings.openai_model,
                    messages=[{"role": "user", "content": prompt}],
                    # Some standards are long enough that the small model
                    # otherwise stops before emitting any text. This is still
                    # a short one-sentence generation, but leaves room for a
                    # complete response and avoids silently shrinking the set.
                    max_completion_tokens=240
                )
                query = (resp.choices[0].message.content or "").strip().strip('"')
                if not query:
                    print(f"Failed to generate a non-empty query for {code}")
                    continue
                print(f"[{course}] {code} -> {query}")
                golden_cases.append({
                    "course": course,
                    "raw_course": c.get("course"),
                    "grade": c.get("grade", 11),
                    "query": query,
                    "expected_code": code,
                    "source_type": c.get("source_type"),
                })
            except Exception as e:  # noqa: BLE001 - keep one bad case from aborting generation
                print(f"Failed to generate for {code}: {e}")

    out_dir = PROJECT_ROOT / "data" / "eval"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "current_golden_cases.json"
    
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(golden_cases, f, indent=2)
        
    print(f"\nWrote {len(golden_cases)} golden cases to {out_path.name}")

if __name__ == "__main__":
    main()
