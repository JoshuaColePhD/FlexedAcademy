"""Offline fixture validation by default; explicit opt-in for metered live samples.

Evaluates consultation policy/transport, not retrieval or successful artifact saves.
Tool calls are recorded, never executed. Human scoring is deliberately separate
from deterministic checks; a valid action is not evidence of a useful lesson.
"""
from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def cases():
    rows = json.loads((Path(__file__).with_name("chat_consultation_cases.json")).read_text())
    assert len(rows) == 25 and len({row["id"] for row in rows}) == len(rows)
    assert all(len(row["turns"]) >= 2 and row["must_preserve"] and len(row["rubric"]) == 5 for row in rows)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--max-usd", type=float, default=0)
    parser.add_argument("--variant", choices=["current", "baseline"], default="current")
    parser.add_argument("--output", type=Path, default=Path("/tmp/flexed-consultation-benchmark.json"))
    args = parser.parse_args()
    rows = cases()
    if not args.live:
        print(f"Validated {len(rows)} multi-turn fixtures. No API calls or model-quality claims.")
        return
    if not 0 < args.max_usd <= 20:
        parser.error("Live evaluation requires an explicitly approved --max-usd between 0 and 20.")

    from openai import OpenAI

    from backend.chat_policy import CHAT_PARTNER_POLICY, typed_chat_tools
    from backend.chat_transport import ResponsesChatStream, reasoning_effort
    from backend.config import settings
    from backend.costs import estimate_text_cost
    from backend.llm import CHAT_TOOLS

    # Importing settings may load .env. Never connect to its database; this
    # benchmark calls only the provider with the synthetic fixtures above.
    settings.database_url = ""
    if estimate_text_cost(settings.openai_model, 1, 1) is None:
        parser.error("The configured model has no checked-in price; add its price before a metered run.")
    policy = CHAT_PARTNER_POLICY
    if args.variant == "baseline":
        source = subprocess.run(["git", "show", "d537bdc:backend/chat_policy.py"], cwd=ROOT, check=True, capture_output=True, text=True).stdout
        policy = next(ast.literal_eval(node.value) for node in ast.parse(source).body
            if isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == "CHAT_PARTNER_POLICY" for name in node.targets))
    tools = typed_chat_tools(CHAT_TOOLS, quizzes_enabled=False)
    client = OpenAI(api_key=settings.openai_api_key, max_retries=0, timeout=60)
    report = {"variant": args.variant, "model": settings.openai_model, "scope": "Synthetic policy/transport comparison; not the ChatGPT product; no tool execution", "estimated_spend_usd": 0, "samples": []}
    stop = False
    for case in rows:
        history = [{"role": "system", "content": policy + "\nSynthetic teaching consultation. Default class: AP English, grade 11. Five-day district template, 45-minute periods. Follow explicitly supplied class changes. No research sources supplied. Active target_plan_id: benchmark-plan. Tool actions are recorded by the evaluator; never claim an artifact was saved."}]
        for index, prompt in enumerate(case["turns"]):
            history.append({"role": "user", "content": prompt})
            cap = 5000
            # UTF-8 bytes conservatively bound tokens, including tool schemas.
            upper = estimate_text_cost(settings.openai_model, len(json.dumps([history, tools]).encode()), cap)
            if report["estimated_spend_usd"] + upper > args.max_usd:
                stop = True
                break
            started, first = time.monotonic(), None
            text, name, arguments, usage = "", None, "", None
            stream = None
            sample = {"case": case["id"], "turn": index + 1, "prompt": prompt, "human_scores": None}
            try:
                if args.variant == "current":
                    stream = ResponsesChatStream(client, model=settings.openai_model, messages=history,
                        effort=reasoning_effort(history), max_tokens=cap, tools=tools)
                else:
                    stream = client.chat.completions.create(model=settings.openai_model, messages=history,
                        tools=tools, reasoning_effort="none", max_completion_tokens=cap, stream=True,
                        parallel_tool_calls=False, stream_options={"include_usage": True})
                for chunk in stream:
                    if chunk.usage:
                        usage = chunk.usage
                    for choice in chunk.choices:
                        delta = choice.delta
                        if delta.content or delta.tool_calls:
                            first = first if first is not None else time.monotonic()
                        text += delta.content or ""
                        for call in delta.tool_calls or []:
                            name = call.function.name or name
                            arguments += call.function.arguments or ""
                sample.update(text=text, tool=name, arguments=json.loads(arguments) if arguments else None)
                history.append({"role": "assistant", "content": text or f"Proposed action for evaluation: {name} {arguments}. This action has not been executed."})
            except Exception as error:  # Save the partial run; never replay a paid call automatically.
                sample["error_type"] = type(error).__name__
                stop = True
            finally:
                if stream is not None:
                    stream.close()
                spent = estimate_text_cost(settings.openai_model, usage.prompt_tokens, usage.completion_tokens) if usage else upper
                report["estimated_spend_usd"] += spent
                sample.update(duration_ms=round((time.monotonic() - started) * 1000), first_response_ms=round((first - started) * 1000) if first else None,
                    estimated_cost_usd=spent, usage_available=usage is not None)
                report["samples"].append(sample)
                args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            if stop:
                break
        if stop:
            break
    print(f"Recorded {len(report['samples'])} turns; estimated spend ${report['estimated_spend_usd']:.4f}. Human review required: {args.output}")


if __name__ == "__main__":
    main()
