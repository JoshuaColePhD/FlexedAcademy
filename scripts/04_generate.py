#!/usr/bin/env python3
"""
Step 4 — Generation
Takes a teacher's query, retrieves relevant standards, and uses OpenAI
to generate a standards-aligned lesson plan outline.
"""

import os
import sys
import argparse
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI
import importlib.util

# We use gpt-4o for superior reasoning and pedagogical nuance.
MODEL_NAME = "gpt-4o"

PROJECT_ROOT = Path(__file__).resolve().parent.parent

def load_retrieve_module():
    """Dynamically load 03_retrieve.py so we can use its retrieve function."""
    retrieve_path = PROJECT_ROOT / "scripts" / "03_retrieve.py"
    spec = importlib.util.spec_from_file_location("retrieve_module", str(retrieve_path))
    retrieve_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(retrieve_module)
    return retrieve_module

def generate_lesson_plan(query: str, top_k: int = 5) -> str:
    # Ensure API key is set
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key or api_key == "your-api-key-here":
        raise ValueError(
            "Please set a valid OPENAI_API_KEY in your .env file.\n"
            "You can copy .env.example to .env and add your key."
        )

    client = OpenAI(api_key=api_key)
    retrieve_module = load_retrieve_module()
    
    print(f"Retrieving top {top_k} standards for: '{query}'...")
    chunks = retrieve_module.retrieve(query, top_k=top_k)
    
    if not chunks:
        return "No relevant standards found."

    # Format the retrieved standards into context
    context_parts = []
    for i, c in enumerate(chunks, 1):
        # We include the metadata and document so OpenAI has the full picture
        meta_str = " | ".join(f"{k}: {v}" for k,v in c["metadata"].items())
        context_parts.append(f"Standard {i} [{c['id']}]:\nText: {c['document']}\nMetadata: {meta_str}\n")
    
    standards_context = "\n".join(context_parts)
    
    # Read the skill file to inherit curriculum rules
    skill_path = PROJECT_ROOT / ".agents" / "skills" / "lesson-plan-week" / "SKILL.md"
    skill_instructions = ""
    if skill_path.exists():
        with open(skill_path, "r", encoding="utf-8") as f:
            skill_instructions = f.read()

    system_prompt = (
        "You are an expert AP Language & Composition curriculum designer and master teacher. "
        "Your goal is to help teachers build weekly lesson plans that are rigorously grounded in official standards. "
        "You will be provided with a set of specific AP Lang and state English standards that are relevant "
        "to the teacher's query.\n\n"
        "Here are the specific rules and guidelines for building lesson plans for this teacher:\n"
        f"{skill_instructions}\n\n"
        "---\n\n"
        "Instructions:\n"
        "1. **Pedagogical Arc & Scaffolding**: Design a cohesive progression across the 5 days. Scaffold the learning targets (e.g., Identify -> Apply -> Describe using specific frameworks like SPACE CAT). Make sure activities build logically.\n"
        "2. Draft a structured, day-by-day lesson plan explicitly connecting activities to these standards.\n"
        "3. Favor clarity, correctness, and explainability. Show *how* the activity fulfills the standard.\n"
        "3. DO NOT invent or paraphrase standards. Use only the provided text and their exact IDs.\n"
        "4. You MUST output your final lesson plan strictly as a JSON object matching this exact schema:\n"
        "{\n"
        '  "teacher": "Josh Cole",\n'
        '  "course": "AP Language & Composition",\n'
        '  "week_of": "Week XX — [Dates]",\n'
        '  "period": "3rd period",\n'
        '  "days": [\n'
        "    {\n"
        '      "name": "Monday",\n'
        '      "no_school": false,\n'
        '      "standards": "Standard IDs and descriptions",\n'
        '      "act_alignment": "ACT equivalent standards",\n'
        '      "learning_targets": "I can ...",\n'
        '      "engagement_strategy": "Strategy 1, Strategy 2",\n'
        '      "lesson": "Do Now: ...\\nDuring: ...\\nAssessment: Formative/Summative — ..."\n'
        "    },\n"
        "    ... (Include exactly 5 days: Monday to Friday)\n"
        "  ]\n"
        "}\n"
        "Do not wrap the JSON in markdown blocks. Output raw JSON only."
    )
    
    prompt = (
        f"Teacher's Request: {query}\n\n"
        f"Relevant Standards Context:\n{standards_context}\n\n"
        "Please draft the weekly lesson plan JSON based strictly on these retrieved standards."
    )
    
    print(f"Generating lesson plan with {MODEL_NAME}...")
    response = client.chat.completions.create(
        model=MODEL_NAME,
        max_tokens=2500,
        temperature=0.2, # Low temperature to keep it focused and grounded
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ]
    )
    
    return response.choices[0].message.content

def generate_lesson_plan_stream(query: str, top_k: int = 5):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key or api_key == "your-api-key-here":
        raise ValueError("OPENAI_API_KEY not set.")

    client = OpenAI(api_key=api_key)
    retrieve_module = load_retrieve_module()
    
    chunks = retrieve_module.retrieve(query, top_k=top_k)
    
    if not chunks:
        yield "No relevant standards found."
        return

    context_parts = []
    for i, c in enumerate(chunks, 1):
        meta_str = " | ".join(f"{k}: {v}" for k,v in c["metadata"].items())
        context_parts.append(f"Standard {i} [{c['id']}]:\nText: {c['document']}\nMetadata: {meta_str}\n")
    
    standards_context = "\n".join(context_parts)
    
    skill_path = PROJECT_ROOT / ".agents" / "skills" / "lesson-plan-week" / "SKILL.md"
    skill_instructions = ""
    if skill_path.exists():
        with open(skill_path, "r", encoding="utf-8") as f:
            skill_instructions = f.read()

    system_prompt = (
        "You are an expert AP Language & Composition curriculum designer and master teacher. "
        "Your goal is to help teachers build weekly lesson plans that are rigorously grounded in official standards. "
        "You will be provided with a set of specific AP Lang and state English standards that are relevant "
        "to the teacher's query.\n\n"
        "Here are the specific rules and guidelines for building lesson plans for this teacher:\n"
        f"{skill_instructions}\n\n"
        "---\n\n"
        "Instructions:\n"
        "1. **Pedagogical Arc & Scaffolding**: Design a cohesive progression across the 5 days. Scaffold the learning targets (e.g., Identify -> Apply -> Describe using specific frameworks like SPACE CAT). Make sure activities build logically.\n"
        "2. Draft a structured, day-by-day lesson plan explicitly connecting activities to these standards.\n"
        "3. Favor clarity, correctness, and explainability. Show *how* the activity fulfills the standard.\n"
        "3. DO NOT invent or paraphrase standards. Use only the provided text and their exact IDs.\n"
        "4. You MUST output your final lesson plan strictly as a JSON object matching this exact schema:\n"
        "{\n"
        '  "teacher": "Josh Cole",\n'
        '  "course": "AP Language & Composition",\n'
        '  "week_of": "Week XX — [Dates]",\n'
        '  "period": "3rd period",\n'
        '  "days": [\n'
        "    {\n"
        '      "name": "Monday",\n'
        '      "no_school": false,\n'
        '      "standards": "Standard IDs and descriptions",\n'
        '      "act_alignment": "ACT equivalent standards",\n'
        '      "learning_targets": "I can ...",\n'
        '      "engagement_strategy": "Strategy 1, Strategy 2",\n'
        '      "lesson": "Do Now: ...\\nDuring: ...\\nAssessment: Formative/Summative — ..."\n'
        "    },\n"
        "    ... (Include exactly 5 days: Monday to Friday)\n"
        "  ]\n"
        "}\n"
        "Do not wrap the JSON in markdown blocks. Output raw JSON only."
    )
    
    prompt = (
        f"Teacher's Request: {query}\n\n"
        f"Relevant Standards Context:\n{standards_context}\n\n"
        "Please draft the weekly lesson plan JSON based strictly on these retrieved standards."
    )
    
    response = client.chat.completions.create(
        model=MODEL_NAME,
        max_tokens=2500,
        temperature=0.2,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        stream=True
    )
    
    for chunk in response:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content

def rewrite_lesson_day(day_json: str, feedback: str, full_plan_context: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key or api_key == "your-api-key-here":
        raise ValueError("OPENAI_API_KEY not set.")

    client = OpenAI(api_key=api_key)

    skill_path = PROJECT_ROOT / ".agents" / "skills" / "lesson-plan-week" / "SKILL.md"
    skill_instructions = ""
    if skill_path.exists():
        with open(skill_path, "r", encoding="utf-8") as f:
            skill_instructions = f.read()

    system_prompt = (
        "You are an expert AP Language & Composition curriculum designer. "
        "Your task is to rewrite a single day of a lesson plan based on the teacher's feedback.\n\n"
        "Here are the specific rules and guidelines for building lesson plans for this teacher:\n"
        f"{skill_instructions}\n\n"
        "---\n\n"
        "Context of the full week's plan (for reference only, DO NOT rewrite the whole week):\n"
        f"{full_plan_context}\n\n"
        "---\n\n"
        "Instructions:\n"
        "1. You will be provided with the JSON of the specific day to rewrite, and the teacher's feedback.\n"
        "2. Apply the feedback to modify the day's activities, learning targets, or strategies.\n"
        "3. You MUST output your response strictly as a JSON object matching the exact schema for a single day:\n"
        "{\n"
        '  "name": "Monday",\n'
        '  "no_school": false,\n'
        '  "standards": "...",\n'
        '  "act_alignment": "...",\n'
        '  "learning_targets": "...",\n'
        '  "engagement_strategy": ["..."],\n'
        '  "do_now": "...",\n'
        '  "during": "...",\n'
        '  "assessment": "..."\n'
        "}\n"
        "Do not wrap the JSON in markdown blocks. Output raw JSON only."
    )
    
    prompt = (
        f"Original Day JSON:\n{day_json}\n\n"
        f"Teacher's Feedback: {feedback}\n\n"
        "Please rewrite the day according to the feedback, returning only the updated JSON object."
    )
    
    response = client.chat.completions.create(
        model=MODEL_NAME,
        max_tokens=1000,
        temperature=0.3,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ]
    )
    
    return response.choices[0].message.content

def main():
    parser = argparse.ArgumentParser(description="Generate a lesson plan using retrieved standards.")
    parser.add_argument("query", type=str, help="The topic or request for the lesson plan.")
    parser.add_argument("--top_k", type=int, default=5, help="Number of standards to retrieve.")
    parser.add_argument("--out", type=str, default="Lesson_Plan.docx", help="Output .docx filename.")
    args = parser.parse_args()
    
    # Load environment variables
    load_dotenv(PROJECT_ROOT / ".env")
    
    try:
        json_str = generate_lesson_plan(args.query, args.top_k)
        
        # Clean up any potential markdown code blocks
        if json_str.startswith("```json"):
            json_str = json_str[7:]
        if json_str.startswith("```"):
            json_str = json_str[3:]
        if json_str.endswith("```"):
            json_str = json_str[:-3]
        json_str = json_str.strip()
        
        # Save to temp JSON file
        import json
        import subprocess
        
        temp_json = PROJECT_ROOT / "temp_week.json"
        with open(temp_json, "w") as f:
            f.write(json_str)
            
        print(f"Calling build_lesson_plan.py to generate {args.out}...")
        script_path = PROJECT_ROOT / ".agents" / "skills" / "lesson-plan-week" / "scripts" / "build_lesson_plan.py"
        
        subprocess.run(
            [sys.executable, str(script_path), str(temp_json), args.out],
            check=True
        )
        
        print("\n" + "="*80)
        print(f"SUCCESS: Generated lesson plan saved to {args.out}")
        print("="*80 + "\n")
        
        # Clean up temp file
        temp_json.unlink()
        
    except Exception as e:
        print(f"\nError: {e}")
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
