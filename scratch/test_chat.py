import asyncio
import os
import sys

sys.path.insert(0, os.path.abspath('.'))

from backend.llm import client
from backend.config import settings

def test():
    tools = [
        {
            "type": "function",
            "function": {
                "name": "generate_lesson_plan",
                "description": "Trigger the generation or revision of the lesson plan artifact based on the conversation.",
            },
        },
        {
            "type": "function",
            "function": {
                "name": "ask_clarifying_questions",
                "description": "Call this INSTEAD of generate_lesson_plan...",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "questions": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string", "description": "A short, stable slug, e.g. 'text' or 'skill'."},
                                    "text": {"type": "string", "description": "The question itself, one sentence."},
                                    "options": {
                                        "type": "array",
                                        "minItems": 2,
                                        "maxItems": 5,
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": ["id", "text", "options"],
                            },
                        }
                    },
                    "required": ["questions"],
                },
            },
        },
    ]

    try:
        stream = client().chat.completions.create(
            model=settings.openai_model,
            temperature=0.7,
            max_tokens=4000,
            messages=[{"role": "user", "content": "i need to build week 2 lesson plans"}],
            stream=True,
            tools=tools,
            stream_options={"include_usage": True},
        )
        for chunk in stream:
            print(chunk)
            break
    except Exception as e:
        print(f"Error: {e}")

test()
