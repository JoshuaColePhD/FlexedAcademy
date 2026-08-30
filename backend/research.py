"""Small, bounded research retrieval for teacher coaching conversations.

Research is deliberately an optional context layer.  OpenAlex is a public,
non-commercial scholarly index, so this works without another account or API
key.  A failed lookup returns no sources and normal chat continues; the model
is never invited to invent citations when the lookup is empty.
"""
from __future__ import annotations

import logging
import re

import requests

log = logging.getLogger("flexedacademy.research")

_URL = "https://api.openalex.org/works"
_TIMEOUT = (2.0, 5.0)
_MAX_RESULTS = 5


def _abstract(inverted: dict | None) -> str:
    if not isinstance(inverted, dict):
        return ""
    words: list[tuple[int, str]] = []
    for word, positions in inverted.items():
        if not isinstance(word, str) or not isinstance(positions, list):
            continue
        for position in positions:
            if isinstance(position, int):
                words.append((position, word))
    return " ".join(word for _, word in sorted(words))


def _clean(text: str, limit: int = 700) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def search(query: str, *, subject: str = "", grade: str = "") -> list[dict]:
    """Return a few source records safe to place in a model context.

    The query is teacher-facing and can be conversational.  Subject/grade are
    added only as search hints, not as claims about the returned studies.
    """
    query = _clean(query, 240)
    if not query:
        return []
    search_query = " ".join(part for part in (query, subject, f"grade {grade}" if grade else "") if part)
    try:
        response = requests.get(
            _URL,
            params={
                "search": search_query,
                "filter": "has_abstract:true",
                "per-page": _MAX_RESULTS,
                "select": "id,title,publication_year,doi,authorships,primary_location,open_access,abstract_inverted_index",
                "mailto": "research@flexedacademy.com",
            },
            timeout=_TIMEOUT,
            headers={"User-Agent": "FlexEd-Academy/1.0 (teacher research retrieval)"},
        )
        response.raise_for_status()
        results = response.json().get("results", [])
    except Exception as exc:  # noqa: BLE001 — research must never break chat
        log.warning("research lookup unavailable: %s", exc)
        return []

    sources = []
    for item in results:
        if not isinstance(item, dict):
            continue
        title = _clean(item.get("title") or "Untitled study", 220)
        abstract = _clean(_abstract(item.get("abstract_inverted_index")), 900)
        if not abstract:
            continue
        authors = [
            a.get("author", {}).get("display_name")
            for a in (item.get("authorships") or [])[:3]
            if isinstance(a, dict) and isinstance(a.get("author"), dict)
        ]
        location = item.get("primary_location") or {}
        landing = location.get("landing_page_url") if isinstance(location, dict) else None
        doi = item.get("doi")
        url = doi or landing or item.get("id")
        if not url:
            continue
        sources.append({
            "title": title,
            "year": item.get("publication_year"),
            "authors": [name for name in authors if name],
            "url": url,
            "doi": doi,
            "abstract": abstract,
        })
    return sources[:_MAX_RESULTS]


def prompt_context(sources: list[dict]) -> str:
    if not sources:
        return ""
    blocks = []
    for index, source in enumerate(sources, 1):
        authors = ", ".join(source.get("authors") or []) or "Author not listed"
        year = source.get("year") or "n.d."
        blocks.append(
            f"[{index}] {source.get('title', 'Untitled')} ({year}) — {authors}\n"
            f"URL: {source.get('url', '')}\n"
            f"Abstract: {source.get('abstract', '')}"
        )
    return "\n\n".join(blocks)
