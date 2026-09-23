from types import SimpleNamespace

from backend.costs import cached_tokens_from_usage, estimate_text_cost


def test_luna_cost_estimate_splits_cached_input():
    usage = SimpleNamespace(
        prompt_tokens=1_000_000,
        completion_tokens=2_000_000,
        prompt_tokens_details=SimpleNamespace(cached_tokens=400_000),
    )
    assert cached_tokens_from_usage(usage) == 400_000
    # 600k * $.10/M + 400k * $.01/M + 2M * $.50/M = $1.006
    assert estimate_text_cost(
        "gpt-6-luna",
        usage.prompt_tokens,
        usage.completion_tokens,
        cached_tokens=cached_tokens_from_usage(usage),
    ) == 1.006


def test_unknown_model_is_not_reported_as_free():
    assert estimate_text_cost("future-model", 100, 100) is None
