"""Cross-chat memory for readings already used in a class."""
from __future__ import annotations

import json

from backend import llm, prompts
from backend.retrieval import RetrievalResult


def _saved_plan(week: int, title: str, query: str) -> dict:
    return {
        "week_number": week,
        "week_label": f"Week {week}",
        "unit": "Close reading",
        "query": query,
        "plan_json": json.dumps(
            {
                "days": [
                    {
                        "name": "Monday",
                        "title": title,
                        "learning_targets": "I can analyze the author's diction.",
                        "do_now": "Read the opening passage.",
                        "during": f"Annotate {title} for voice and tone.",
                    }
                ]
            }
        ),
    }


def test_prior_plan_context_is_class_scoped_and_deduplicates_weeks(monkeypatch):
    rows = [
        _saved_plan(7, "Casca Montiota", "Build Week 7 around the Casca Montiota reading."),
        # A regenerated copy of the same week should not duplicate its memory.
        _saved_plan(7, "Casca Montiota", "Regenerate the Casca Montiota week."),
    ]
    monkeypatch.setattr(llm.db, "list_prior_plan_memory", lambda *args, **kwargs: rows)

    context = llm.prior_plan_context_for("teacher-1", "class-1", before_week=9)

    assert "Casca Montiota" in context
    assert context.count("- Week 7:") == 1


def test_prior_plan_context_skips_lookup_without_a_class(monkeypatch):
    called = False

    def fail_lookup(*args, **kwargs):
        nonlocal called
        called = True
        raise AssertionError("classless requests must not query another prep's history")

    monkeypatch.setattr(llm.db, "list_prior_plan_memory", fail_lookup)

    assert llm.prior_plan_context_for("teacher-1", None, before_week=9) == ""
    assert called is False


def test_week_prompt_treats_prior_readings_as_covered_with_reuse_override(monkeypatch):
    monkeypatch.setattr(prompts, "day_names_for_school", lambda *_args, **_kwargs: ["Monday"])
    monkeypatch.setattr(prompts, "weekly_template_context", lambda *_args, **_kwargs: "Monday")

    prompt = prompts.week_system_prompt(
        RetrievalResult(),
        prior_plan_context="- Week 7: original request: Casca Montiota reading",
    )

    assert "already covered" in prompt
    assert "explicitly asks to revisit, reteach, continue, or reuse" in prompt
    assert "Casca Montiota" in prompt
