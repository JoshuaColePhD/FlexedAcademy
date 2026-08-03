#!/usr/bin/env python3
"""
Step 6 — Eval Harness

Evaluates the performance of the RAG pipeline.
1. Retrieval Eval: Tests if specific queries successfully retrieve the expected standard codes within the top K.
2. Generation Eval: Tests if the LLM output is valid JSON matching the expected schema.
"""

import os
import json
from pathlib import Path
from dotenv import load_dotenv
import importlib.util

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Load environment variables (API key)
load_dotenv(PROJECT_ROOT / ".env")

def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

retrieve_module = load_module("retrieve_module", PROJECT_ROOT / "scripts" / "03_retrieve.py")
generate_module = load_module("generate_module", PROJECT_ROOT / "scripts" / "04_generate.py")

RETRIEVAL_TEST_CASES = [
    {
        "query": "Students need practice synthesizing graphic texts like charts and dashboards.",
        "expected_code": "Grade11-2"
    },
    {
        "query": "I want a lesson plan on explaining how an argument understands the audience's beliefs.",
        "expected_code": "1.B"
    },
    {
        "query": "We are focusing on deleting irrelevant material in an essay.",
        "expected_code": "TOD 201"
    },
    {
        "query": "I need a lesson about evaluating tone and credibility through active listening.",
        "expected_code": "Grade11-10"
    }
]

def run_retrieval_evals(top_k=5):
    print("="*80)
    print(f"RUNNING RETRIEVAL EVALS (Top {top_k})")
    print("="*80)
    
    passed = 0
    total = len(RETRIEVAL_TEST_CASES)
    
    for idx, case in enumerate(RETRIEVAL_TEST_CASES, 1):
        query = case["query"]
        expected = case["expected_code"]
        
        chunks = retrieve_module.retrieve(query, top_k=top_k)
        retrieved_codes = [c["id"] for c in chunks]
        
        is_pass = expected in retrieved_codes
        if is_pass:
            passed += 1
            print(f"[{idx}/{total}] PASS: Query -> '{query}'")
            print(f"         Found expected code: {expected}")
        else:
            print(f"[{idx}/{total}] FAIL: Query -> '{query}'")
            print(f"         Expected: {expected}")
            print(f"         Got: {retrieved_codes}")
            
    print(f"\nRetrieval Score: {passed}/{total} ({(passed/total)*100:.1f}%)")
    return passed == total

def run_generation_evals():
    print("\n" + "="*80)
    print("RUNNING GENERATION EVAL")
    print("="*80)
    
    query = "Draft a lesson plan on using transition words in essays."
    print(f"Generating plan for: '{query}'...")
    
    # We test the pure generation logic without docx side-effects
    try:
        raw_json_str = generate_module.generate_lesson_plan(query, top_k=3)
        
        # Cleanup markdown
        if raw_json_str.startswith("```json"):
            raw_json_str = raw_json_str[7:]
        if raw_json_str.startswith("```"):
            raw_json_str = raw_json_str[3:]
        if raw_json_str.endswith("```"):
            raw_json_str = raw_json_str[:-3]
        raw_json_str = raw_json_str.strip()
        
        # Attempt to parse
        data = json.loads(raw_json_str)
        
        # Verify schema
        assert "teacher" in data, "Missing 'teacher' field"
        assert "days" in data, "Missing 'days' list"
        assert len(data["days"]) == 5, f"Expected 5 days, got {len(data['days'])}"
        
        # Verify first day schema
        day1 = data["days"][0]
        assert "name" in day1
        assert "curriculum" in day1
        assert "standards" in day1
        
        print("PASS: Generation resulted in valid JSON that matches the schema.")
        return True
        
    except json.JSONDecodeError as e:
        print("FAIL: Generated text was not valid JSON.")
        print(f"Error: {e}")
        print("Raw output:")
        print(raw_json_str)
        return False
    except AssertionError as e:
        print(f"FAIL: JSON schema violation: {e}")
        return False
    except Exception as e:
        print(f"FAIL: Unexpected error during generation eval: {e}")
        return False

def main():
    retrieval_ok = run_retrieval_evals()
    generation_ok = run_generation_evals()
    
    print("\n" + "="*80)
    print("EVAL HARNESS SUMMARY")
    print("="*80)
    print(f"Retrieval Eval : {'PASS' if retrieval_ok else 'FAIL'}")
    print(f"Generation Eval: {'PASS' if generation_ok else 'FAIL'}")
    
    if not (retrieval_ok and generation_ok):
        return 1
    return 0

if __name__ == "__main__":
    import sys
    sys.exit(main())
