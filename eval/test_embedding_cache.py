"""The corpus embedding cache reuses unchanged documents without API calls."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = PROJECT_ROOT / "scripts" / "02_embed_store.py"


def load_embed_script():
    spec = importlib.util.spec_from_file_location("embed_store", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load embed script")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    module = load_embed_script()
    calls: list[list[str]] = []

    def fake_embed(texts: list[str]) -> list[list[float]]:
        calls.append(texts)
        return [[float(index)] * module.EMBED_DIMS for index, _ in enumerate(texts, 1)]

    with tempfile.TemporaryDirectory() as temp:
        module.EMBED_CACHE_PATH = Path(temp) / "embeddings.sqlite3"
        with patch("backend.embeddings.embed_texts", side_effect=fake_embed):
            first, first_reused = module.embed_documents_cached(["alpha", "beta", "alpha"])
            second, second_reused = module.embed_documents_cached(["alpha", "beta", "alpha"])
            third, third_reused = module.embed_documents_cached(["alpha", "gamma"])

    failures = []
    if len(calls) != 2 or calls != [["alpha", "beta"], ["gamma"]]:
        failures.append(f"unexpected API calls: {calls}")
    if first_reused != 0 or second_reused != 3 or third_reused != 1:
        failures.append(f"unexpected reuse counts: {first_reused}, {second_reused}, {third_reused}")
    if first != second or first[0] != third[0]:
        failures.append("cached vectors did not round-trip consistently")

    if failures:
        print("FAIL — " + "; ".join(failures))
        return 1
    print("PASS — unchanged documents reuse cached vectors; only new text calls the embedding API.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
