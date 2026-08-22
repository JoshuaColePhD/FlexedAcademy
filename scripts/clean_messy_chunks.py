#!/usr/bin/env python3
import json
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MESSY_PATH = PROJECT_ROOT / "data" / "processed" / "ap_scratch_messy.json"
FINAL_PATH = PROJECT_ROOT / "data" / "processed" / "ap_chunks.json"

def clean_description(text):
    # Remove known footer/header garbage
    garbage_phrases = [
        "continued on next page",
        "Course Framework V",
        "Course and Exam Description",
        "ENDURING UNDERSTANDING",
        "LEARNING OBJECTIVE",
        "ESSENTIAL KNOWLEDGE",
        "The Sample Instructional Activities",
        "Return to Table of Contents",
        "AP Microeconomics",
        "AP Computer Science Principles",
        "AP Comparative Government and Politics"
    ]
    
    for phrase in garbage_phrases:
        idx = text.find(phrase)
        if idx != -1:
            text = text[:idx]
            
    # Try to end cleanly on a period
    # If the text doesn't end in a period, it might be cut off, so we find the last period.
    text = text.strip()
    if text and text[-1] not in ('.', '?', '!'):
        last_period = text.rfind('.')
        if last_period != -1:
            text = text[:last_period+1]
            
    return re.sub(r'\s+', ' ', text).strip()

def main():
    print("Loading messy chunks...")
    with open(MESSY_PATH, 'r', encoding='utf-8') as f:
        messy_chunks = json.load(f)

    print(f"Cleaning {len(messy_chunks)} chunks...")
    cleaned_chunks = []
    
    for chunk in messy_chunks:
        original = chunk['description']
        cleaned = clean_description(original)
        
        # If we cleaned it so much it's gone, or it's clearly a bad parse
        if len(cleaned) < 10:
            continue
            
        chunk['description'] = cleaned
        chunk['embed_text'] = f"Course: {chunk['course']} — Unknown\n[{chunk['code']}] {cleaned}"
        cleaned_chunks.append(chunk)

    print(f"Kept {len(cleaned_chunks)} cleaned chunks.")

    # Append to ap_chunks.json
    print("Loading existing ap_chunks.json...")
    with open(FINAL_PATH, 'r', encoding='utf-8') as f:
        existing_chunks = json.load(f)

    # Remove any existing chunks for these 3 courses so we don't duplicate
    target_courses = {"AP Comparative Government and Politics", "AP Computer Science Principles", "AP Microeconomics"}
    kept_chunks = [c for c in existing_chunks if c.get('course') not in target_courses]
    
    final_chunks = kept_chunks + cleaned_chunks
    
    with open(FINAL_PATH, 'w', encoding='utf-8') as f:
        json.dump(final_chunks, f, indent=2, ensure_ascii=False)
        
    print(f"Successfully appended to {FINAL_PATH} (Total chunks: {len(final_chunks)})")

if __name__ == "__main__":
    main()
