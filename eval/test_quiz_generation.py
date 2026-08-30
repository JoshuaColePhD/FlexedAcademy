#!/usr/bin/env python3
"""Quiz generation: llm.generate_quiz -> schema.validate_quiz -> qti_build,
end to end.

This feature has no other test coverage, and it is the largest single
addition of its session: a new LLM call, a new JSON schema, and a QTI 1.2
zip writer with four different question-type shapes. The promises:

  1. generate_quiz's prompt hands the model the PLAN'S OWN content as its
     only source material and names the requested question type(s) — never
     a fresh retrieval, never a type the teacher didn't ask for.
  2. validate_quiz accepts a structurally sound quiz covering all four
     question types and reports which questions cite no standard, without
     raising.
  3. validate_quiz REJECTS a quiz malformed enough that qti_build could not
     produce a gradable item from it (a multiple_choice with correct_index
     out of range) — this has to be fatal, not a warning, because a Canvas
     item with no correct answer marked is worse than one that never
     imported at all.
  4. build_qti_zip's output is a real zip containing two well-formed XML
     files; the manifest's own <file href> points at the assessment file
     that's actually in the package; every question type renders without
     raising.

The OpenAI call itself is stubbed (llm.client) — this is not a test that the
model writes good quiz questions, it is a test that the plumbing around
that call is correct. Canvas import fidelity is NOT covered here: there is
no live Canvas instance in this environment. See qti_build.py's own
module docstring.

Run:  ./venv/bin/python eval/test_quiz_generation.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import llm, qti_build, schema  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


SAMPLE_PLAN = {
    "week_of": "Week 04 — Aug 24-28, 2026",
    "days": [
        {
            "name": "Monday",
            "no_school": False,
            "title": "Irony workshop",
            "learning_targets": "I can identify verbal, situational, and dramatic irony in a text.",
            "standards": "RHS-2.C — Explain how word choice conveys tone through irony.",
            "act_alignment": "TOD 502",
            "engagement_strategy": "Think/Pair/Share",
            "do_now": "Read the opening of 'The Cask of Amontillado.'",
            "during": "Annotate each ironic statement Montresor makes.",
            "assessment": "Exit ticket: one example of dramatic irony, cited.",
        },
    ],
}

SAMPLE_QUIZ = {
    "title": "Week 04 Quiz — Irony",
    "questions": [
        {
            "type": "multiple_choice",
            "prompt": "Which term describes Montresor's friendliness while planning Fortunato's death?",
            "standard_code": "RHS-2.C",
            "choices": ["Verbal irony", "Dramatic irony", "Situational irony", "Litotes"],
            "correct_index": 1,
            "correct_bool": False,
            "accepted_answers": [],
            "pairs": [],
        },
        {
            "type": "true_false",
            "prompt": "Dramatic irony requires the reader to know something a character does not.",
            "standard_code": "RHS-2.C",
            "choices": [],
            "correct_index": -1,
            "correct_bool": True,
            "accepted_answers": [],
            "pairs": [],
        },
        {
            "type": "short_answer",
            "prompt": "Name the narrator of 'The Cask of Amontillado.'",
            "standard_code": "",
            "choices": [],
            "correct_index": -1,
            "correct_bool": False,
            "accepted_answers": ["Montresor"],
            "pairs": [],
        },
        {
            "type": "matching",
            "prompt": "Match each irony type to its definition.",
            "standard_code": "RHS-2.C",
            "choices": [],
            "correct_index": -1,
            "correct_bool": False,
            "accepted_answers": [],
            "pairs": [
                {"term": "Verbal irony", "match": "Saying one thing, meaning another"},
                {"term": "Dramatic irony", "match": "Audience knows what a character doesn't"},
            ],
        },
    ],
}


def _fake_response(content: str):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content, refusal=None))],
        usage=None,  # llm._record skips entirely on a falsy usage — see its own docstring.
    )


def main() -> int:
    real_client = llm.client
    real_get_cache, real_set_cache = llm.db.get_llm_cache, llm.db.set_llm_cache
    # Deterministic and side-effect-free: a cache hit would skip the stubbed
    # client entirely on a second run, and a real write would leave a row in
    # whatever database this environment happens to be pointed at.
    llm.db.get_llm_cache = lambda _hash: None
    llm.db.set_llm_cache = lambda _hash, _resp: None

    captured = {}

    def fake_client():
        class _Completions:
            @staticmethod
            def create(**kwargs):
                captured["messages"] = kwargs["messages"]
                return _fake_response(json.dumps(SAMPLE_QUIZ))

        return SimpleNamespace(chat=SimpleNamespace(completions=_Completions()))

    llm.client = fake_client

    try:
        print("\n1. generate_quiz's prompt is grounded in the plan, not a fresh retrieval")
        quiz = llm.generate_quiz("u", SAMPLE_PLAN, ["multiple_choice", "true_false"], 4)
        system_prompt = next(m["content"] for m in captured["messages"] if m["role"] == "system")
        check("plan content is in the prompt", "Cask of Amontillado" in system_prompt)
        check("plan's own standard code is in the prompt", "RHS-2.C" in system_prompt)
        check("requested types are named", "multiple choice" in system_prompt and "true/false" in system_prompt)
        check("an UNREQUESTED type is not named", "short answer" not in system_prompt and "matching" not in system_prompt)
        check("no fresh retrieval language leaks in", "retriev" not in system_prompt.lower())
        check("returned quiz matches the schema's own top-level shape", set(quiz.keys()) == {"title", "questions"})

        print("\n2. validate_quiz accepts a structurally sound quiz covering all four types")
        warnings = schema.validate_quiz(SAMPLE_QUIZ)
        check("no exception raised", True)
        check(
            "exactly the one uncited question is warned about",
            warnings == ["Q3 (short_answer): no standard cited."],
            repr(warnings),
        )

        print("\n3. validate_quiz rejects what qti_build could not grade")
        bad = json.loads(json.dumps(SAMPLE_QUIZ))  # deep copy
        bad["questions"][0]["correct_index"] = 99  # out of range
        raised = False
        try:
            schema.validate_quiz(bad)
        except schema.QuizSchemaError:
            raised = True
        check("out-of-range correct_index raises QuizSchemaError", raised)

        empty = {"title": "Empty", "questions": []}
        raised = False
        try:
            schema.validate_quiz(empty)
        except schema.QuizSchemaError:
            raised = True
        check("zero questions raises QuizSchemaError", raised)

        print("\n4. build_qti_zip produces a real, well-formed Canvas-importable package")
        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "quiz.zip"
            qti_build.build_qti_zip(SAMPLE_QUIZ, out_path)
            check("file was written", out_path.is_file())

            with zipfile.ZipFile(out_path) as zf:
                names = zf.namelist()
                check("exactly two members", len(names) == 2, repr(names))
                check("imsmanifest.xml present", "imsmanifest.xml" in names)
                assessment_names = [n for n in names if n != "imsmanifest.xml"]
                for n in names:
                    try:
                        ET.fromstring(zf.read(n))
                        well_formed = True
                    except ET.ParseError:
                        well_formed = False
                    check(f"{n} is well-formed XML", well_formed)

                manifest_text = zf.read("imsmanifest.xml").decode()
                referenced = assessment_names and assessment_names[0] in manifest_text
                check("manifest references the actual assessment file", referenced)

                assessment_root = ET.fromstring(zf.read(assessment_names[0]))
                check(
                    "assessment root is questestinterop",
                    assessment_root.tag.endswith("questestinterop"),
                )
                items = assessment_root.findall(".//{http://www.imsglobal.org/xsd/ims_qtiasiv1p2}item")
                check("one <item> per question", len(items) == len(SAMPLE_QUIZ["questions"]), f"got {len(items)}")

        print("\n5. Every question type builds without raising, on its own")
        for q in SAMPLE_QUIZ["questions"]:
            solo = {"title": f"Solo {q['type']}", "questions": [q]}
            with tempfile.TemporaryDirectory() as tmp:
                try:
                    qti_build.build_qti_zip(solo, Path(tmp) / "solo.zip")
                    check(f"{q['type']} builds alone", True)
                except Exception as e:  # noqa: BLE001
                    check(f"{q['type']} builds alone", False, str(e))
    finally:
        llm.client = real_client
        llm.db.get_llm_cache, llm.db.set_llm_cache = real_get_cache, real_set_cache

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — quiz generation, validation, and the QTI package it writes all hold together.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
