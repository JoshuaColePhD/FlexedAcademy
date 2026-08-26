"""Text -> vector, in one place, via the OpenAI embeddings API.

Replaces a local `all-MiniLM-L6-v2` through sentence-transformers, which pulled
torch (518MB) and transformers (98MB) into the image to do exactly this one job.
Those two dependencies were most of why this app was awkward to host: they
dwarfed a 512MB free instance, had to be downloaded from huggingface.co on first
boot, and the CrossEncoder reranker on top of them could OOM the container in a
way no try/except could catch.

`text-embedding-3-small` takes a `dimensions` argument, so it can emit 384 floats
and the existing `vector(384)` column and HNSW index stay exactly as they are.
That is the only reason this swap is cheap rather than a schema migration.

THE THING TO KNOW: a different model means a different distance distribution, so
`RETRIEVAL_MAX_DISTANCE` — the relevance floor that refuses off-domain queries —
does not carry over. It was measured for MiniLM. Re-measure it with
scripts/06_threshold_sweep.py after any re-embed, or the floor either passes
everything or rejects everything, silently.
"""

from __future__ import annotations

import logging
import time

from .errors import AppError

log = logging.getLogger("flexedacademy.embeddings")

# Must match what the corpus was embedded with. Changing either of these means
# re-running scripts/02_embed_store.py over the whole corpus — a query vector
# from one model is meaningless against documents embedded with another.
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 384

# The API caps inputs per request; well under it, and small enough that a retry
# is cheap. 26k chunks is ~104 requests.
BATCH = 256
_MAX_ATTEMPTS = 5


def _client():
    # Reuses llm.client() so the missing-key error is the same one users already
    # see for generation, rather than a second variant of it.
    from .llm import client

    return client()


def _embed_batch(texts: list[str]) -> list[list[float]]:
    """One API call, retried on transient failure with exponential backoff."""
    last: Exception | None = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = _client().embeddings.create(
                model=EMBED_MODEL,
                input=texts,
                dimensions=EMBED_DIMS,
            )
            # The API documents order preservation, but this is a silent-corruption
            # class of bug if it ever stops holding: a mismatched vector attaches
            # the wrong standard to a query and nothing looks broken.
            return [d.embedding for d in sorted(resp.data, key=lambda d: d.index)]
        except AppError:
            raise  # no API key — retrying will not help
        except Exception as exc:  # noqa: BLE001 — surfaced below after retries
            last = exc
            wait = 2**attempt
            log.warning(
                "embedding batch failed (attempt %d/%d): %s — retrying in %ds",
                attempt + 1, _MAX_ATTEMPTS, exc, wait,
            )
            time.sleep(wait)
    raise AppError(
        "embedding_failed",
        "Could not reach the embeddings API.",
        status=503,
        hint="Check OPENAI_API_KEY and network access, then try again.",
    ) from last


def embed_query(text: str) -> list[float]:
    """A single query vector. One API call."""
    if not text or not text.strip():
        raise AppError("empty_query", "Nothing to search for.", status=422)
    return _embed_batch([text])[0]


def embed_queries(texts: list[str]) -> dict[str, list[float]]:
    """Vectors for several queries in ONE API call, keyed by the query text.

    Retrieval issues the same handful of query strings against five strata, and
    retrieve_raw embedded on every call — 30 round trips for 6 distinct strings,
    six seconds of a twenty-second generation spent re-embedding text the
    process had already embedded moments earlier.

    Deduplicated and batched: the embeddings endpoint takes an array, so 30
    sequential requests become one. Returning a dict rather than a list is what
    lets the caller look a vector up by text and stop caring about order.
    """
    uniq = [t for t in dict.fromkeys(t for t in texts if t and t.strip())]
    if not uniq:
        raise AppError("empty_query", "Nothing to search for.", status=422)
    return dict(zip(uniq, _embed_batch(uniq)))


def embed_texts(texts: list[str], *, on_progress=None) -> list[list[float]]:
    """Vectors for a whole corpus, batched.

    `on_progress(done, total)` is called after each batch so the ingest script
    can report rather than sit silent for a few minutes.
    """
    out: list[list[float]] = []
    total = len(texts)
    for i in range(0, total, BATCH):
        batch = texts[i : i + BATCH]
        # The API rejects empty strings; a blank document is a bug upstream but
        # should not abort a 26k-row ingest.
        out.extend(_embed_batch([t if t and t.strip() else " " for t in batch]))
        if on_progress:
            on_progress(min(i + BATCH, total), total)
    return out
