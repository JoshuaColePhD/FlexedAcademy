from copy import deepcopy

import pytest

from backend.schema import SchemaError, apply_plan_patch

PLAN = {
    "week_of": "Week 18 — Nov 30–Dec 4, 2026",
    "days": [
        {"name": "Monday", "during": "Original Monday", "do_now": "Bell work", "engagement_strategy": ["Think/Pair/Share"]},
        {"name": "Wednesday", "during": "Original Wednesday", "do_now": "Warmup", "engagement_strategy": ["Small Groups"]},
    ],
}


def test_patch_changes_only_named_cells():
    patched = apply_plan_patch(PLAN, {
        "updates": [
            {"day": "Wednesday", "field": "during", "text": "Sentence frames, then write.", "tags": []},
        ]
    })
    assert patched["days"][0]["during"] == "Original Monday"
    assert patched["days"][1]["during"] == "Sentence frames, then write."
    assert patched["days"][1]["do_now"] == "Warmup"


def test_empty_patch_is_rejected():
    with pytest.raises(SchemaError, match="did not change"):
        apply_plan_patch(PLAN, {"updates": []})


def test_engagement_tags_replace_the_cell():
    patched = apply_plan_patch(deepcopy(PLAN), {
        "updates": [
            {"day": "Monday", "field": "engagement_strategy", "text": "", "tags": ["A/B Partners", "Small Groups"]},
        ]
    })
    assert patched["days"][0]["engagement_strategy"] == ["A/B Partners", "Small Groups"]
