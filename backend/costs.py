"""Small, explicit cost estimates for the usage ledger.

These are estimates for operating decisions, not an invoice.  The model price
table is deliberately kept in code so a model change cannot silently make the
admin cost report look precise while using the wrong rate.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TextModelPricing:
    input_per_million: float
    cached_input_per_million: float
    output_per_million: float


# USD per one million tokens.  Update this table when OPENAI_MODEL changes.
TEXT_MODEL_PRICING: dict[str, TextModelPricing] = {
    "gpt-5.6-luna": TextModelPricing(0.20, 0.02, 1.20),
}


def cached_tokens_from_usage(usage) -> int:
    """Read cached-input tokens across SDK response object/dict shapes."""
    details = getattr(usage, "prompt_tokens_details", None)
    if details is None and isinstance(usage, dict):
        details = usage.get("prompt_tokens_details")
    if details is None:
        return 0
    value = getattr(details, "cached_tokens", None)
    if value is None and isinstance(details, dict):
        value = details.get("cached_tokens")
    return max(0, int(value or 0))


def estimate_text_cost(
    model: str,
    tokens_in: int,
    tokens_out: int,
    *,
    cached_tokens: int = 0,
) -> float | None:
    """Return an estimated USD charge, or None for an unknown model.

    ``tokens_in`` is the total prompt-token count reported by OpenAI.  Cached
    input is split out and priced at the model's cached-input rate.
    """
    pricing = TEXT_MODEL_PRICING.get(model)
    if pricing is None:
        return None
    prompt = max(0, int(tokens_in or 0))
    completion = max(0, int(tokens_out or 0))
    cached = min(prompt, max(0, int(cached_tokens or 0)))
    uncached = prompt - cached
    estimate = (
        uncached * pricing.input_per_million
        + cached * pricing.cached_input_per_million
        + completion * pricing.output_per_million
    ) / 1_000_000
    return round(estimate, 8)


def estimate_embedding_cost(model: str, tokens: int) -> float | None:
    """Return the estimated USD charge for an embeddings request."""
    if model != "text-embedding-3-small":
        return None
    return round(max(0, int(tokens or 0)) * 0.02 / 1_000_000, 8)
