#!/usr/bin/env python3
"""Field-scoped revise: does editing one cell leave every other cell alone?

In-cell tweaking exists so a teacher can fix Wednesday's Do Now without
regenerating Wednesday. The danger is quiet: a whole-day rewrite also re-emits
that day's `standards` and `engagement_strategy`, so "make the Do Now a
quickwrite" could silently re-roll the grounding audit this app exists to
guarantee — and nothing on screen would say so.

So the promise is stated as a test rather than as a hope about the prompt:

  1. A scoped revise changes exactly one key. Every sibling is byte-identical.
  2. A field that cannot carry a standard code does not re-run retrieval or the
     grounding audit. That is the entire point of the scope.
  3. `standards` and `act_alignment` DO re-run both — they carry codes.
  4. `field: None` still regenerates the whole day, exactly as before.
  5. An unknown field is refused before it can reach a prompt as a schema key.

No database, no API: every collaborator is stubbed.

Run:  ./venv/bin/python eval/test_field_scoped_revise.py
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import schema, service  # noqa: E402
from backend.errors import AppError  # noqa: E402
from backend.retrieval import RetrievalResult  # noqa: E402

PLAN_ID = "plan_test"
USER = "user_test"

WEDNESDAY = {
    "name": "Wednesday",
    "no_school": False,
    "learning_targets": "I can trace dramatic irony across a narrative.",
    "standards": "ELA21.11.R2 -- Analyze how an author develops a point of view",
    "act_alignment": "TOD 502",
    "engagement_strategy": ["Think/Pair/Share", "Gallery Walk"],
    "do_now": "What does Fortunato think is happening?",
    "during": "Jigsaw the middle section; each group tracks one ironic reversal.",
    "assessment": "Exit ticket: one reversal, cited.",
}

PLAN = {
    "week_of": "Week 03 — Aug 17-21, 2026",
    "teacher": "Josh Cole",
    "course": "AP Language & Composition",
    "period": "3rd period",
    "days": [
        {**WEDNESDAY, "name": "Monday", "do_now": "Rank four openings by trust."},
        {**WEDNESDAY, "name": "Tuesday"},
        copy.deepcopy(WEDNESDAY),
        {**WEDNESDAY, "name": "Thursday"},
        {"name": "Friday", "no_school": True},
    ],
}

WED_INDEX = 2


class Calls:
    """What the stubs were asked to do, so the test can assert on absence too."""

    def __init__(self):
        self.retrieved = 0
        self.audited = 0
        self.whole_day = 0
        self.scoped = []  # the field names asked for
        self.saved_plan = None


def install_stubs(calls: Calls, new_value):
    """Swap every collaborator of service.revise_day for a recording stub."""

    class FakeDb:
        @staticmethod
        def get_plan(user_id, plan_id):
            return {
                "id": plan_id,
                "plan_json": copy.deepcopy(PLAN),
                "retrieved_ids": ["ELA21.11.R2", "TOD 502"],
                "warnings": [],
                "week_label": PLAN["week_of"],
            }

        @staticmethod
        def get_settings_row(user_id):
            return {"subject": "AP Language & Composition", "grade": "11"}

        @staticmethod
        def update_plan(user_id, plan_id, **kw):
            calls.saved_plan = kw["plan_json"]
            return {"id": plan_id, **kw}

    class FakeRetrieval:
        @staticmethod
        def retrieve_grounded(*a, **kw):
            calls.retrieved += 1
            return RetrievalResult()

        @staticmethod
        def audit_grounding(*a, **kw):
            calls.audited += 1
            return []

    class FakeLlm:
        @staticmethod
        def rewrite_day_field(user_id, day, feedback, field, ctx, result):
            calls.scoped.append(field)
            return new_value

        @staticmethod
        def rewrite_day(user_id, day, feedback, ctx, result):
            calls.whole_day += 1
            # A whole-day rewrite legitimately re-emits every field. This one
            # changes two of them, which is exactly the behaviour scoping exists
            # to avoid.
            return {**day, "do_now": "Two-minute quickwrite.", "act_alignment": "ORG 403"}

    class FakeDocx:
        @staticmethod
        def plan_output_path(plan, plan_id):
            return Path("/dev/null")

        @staticmethod
        def build_docx(plan, out_path):
            return None

    service.db = FakeDb
    service.retrieval = FakeRetrieval
    service.llm = FakeLlm
    service.docx_build = FakeDocx


def revise(field, feedback="Make it a two-minute quickwrite instead", new_value="A two-minute quickwrite on Fortunato's blind spot."):
    calls = Calls()
    install_stubs(calls, new_value)
    service.revise_day(USER, PLAN_ID, WED_INDEX, feedback, field)
    return calls


failures: list[str] = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}{(' — ' + detail) if detail else ''}")
        failures.append(label)


print("\n1. a scoped revise changes exactly one key")
calls = revise("do_now")
saved = calls.saved_plan["days"][WED_INDEX]
check("do_now changed", saved["do_now"] != WEDNESDAY["do_now"])
for key, was in WEDNESDAY.items():
    if key == "do_now":
        continue
    check(f"{key} byte-identical", saved[key] == was, f"{saved[key]!r} != {was!r}")

print("\n   ...and no other day moved")
for i, day in enumerate(calls.saved_plan["days"]):
    if i != WED_INDEX:
        check(f"day {i} untouched", day == PLAN["days"][i])

print("\n2. a non-code field skips retrieval and the grounding audit")
check("no retrieval", calls.retrieved == 0, f"retrieved {calls.retrieved}x")
check("no audit", calls.audited == 0, f"audited {calls.audited}x")
check("scoped call made", calls.scoped == ["do_now"], str(calls.scoped))

for field in ("learning_targets", "during", "assessment", "engagement_strategy"):
    value = ["Cold Call"] if field == "engagement_strategy" else "I can do the new thing." if field == "learning_targets" else "New text."
    c = revise(field, new_value=value)
    check(f"{field}: no retrieval", c.retrieved == 0)
    check(f"{field}: no audit", c.audited == 0)

print("\n3. a code-bearing field DOES re-run retrieval and the audit")
for field in schema.CODE_BEARING_FIELDS:
    c = revise(field, new_value="ELA21.11.R2 -- something grounded")
    check(f"{field}: retrieval ran", c.retrieved == 1, f"{c.retrieved}x")
    check(f"{field}: audit ran", c.audited == 1, f"{c.audited}x")

print("\n4. field=None is the old whole-day path, unchanged")
calls = revise(None)
check("whole-day rewrite used", calls.whole_day == 1)
check("no scoped call", calls.scoped == [])
check("retrieval ran", calls.retrieved == 1)
check("audit ran", calls.audited == 1)
saved = calls.saved_plan["days"][WED_INDEX]
check(
    "siblings ARE allowed to move on a whole-day revise",
    saved["act_alignment"] != WEDNESDAY["act_alignment"],
    "the whole-day path should not be silently scoped",
)

print("\n5. an unknown field is refused before it reaches a prompt")
for bad in ("week_of", "name", "no_school", "'; DROP TABLE plans; --", ""):
    calls = Calls()
    install_stubs(calls, "x")
    try:
        service.revise_day(USER, PLAN_ID, WED_INDEX, "anything", bad)
        check(f"{bad!r} refused", False, "it was accepted")
    except AppError as e:
        check(f"{bad!r} refused", e.code == "bad_field" and e.status == 400, e.code)
    check(f"{bad!r} never reached the model", calls.scoped == [] and calls.whole_day == 0)

print("\n6. every REVISABLE_FIELD has a one-key response schema")
for field in schema.REVISABLE_FIELDS:
    s = schema.field_json_schema(field)
    check(f"{field} schema", list(s["properties"]) == [field] and s["required"] == [field])

print()
if failures:
    print(f"FAILED — {len(failures)} check(s): {', '.join(failures[:5])}")
    sys.exit(1)
print("PASSED — a field-scoped revise touches exactly one key.")
