#!/usr/bin/env python3
"""Step 7 — Generate Golden Evaluation Dataset

Queries the existing ChromaDB to find 2 standards per framework,
and asks OpenAI to generate a realistic "teacher prompt" that SHOULD
retrieve that standard.
Outputs to data/eval/golden_cases.json.
"""

import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import retrieval
from backend.llm import client
from backend.config import settings

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
    
    # Take 2 random chunks per course to keep costs low
    import random
    random.seed(42)
    
    for course, chunks in by_course.items():
        sample = random.sample(chunks, min(2, len(chunks)))
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
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.7,
                    max_tokens=50
                )
                query = resp.choices[0].message.content.strip().strip('"')
                print(f"[{course}] {code} -> {query}")
                golden_cases.append({
                    "course": course,
                    "grade": c.get("grade", "11"),
                    "query": query,
                    "expected_code": code
                })
            except Exception as e:
                print(f"Failed to generate for {code}: {e}")

    out_dir = PROJECT_ROOT / "data" / "eval"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "golden_cases.json"
    
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(golden_cases, f, indent=2)
        
    print(f"\nWrote {len(golden_cases)} golden cases to {out_path.name}")

if __name__ == "__main__":
    main()
