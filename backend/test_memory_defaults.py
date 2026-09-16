"""Safe-for-small-box defaults must hold when memory env vars are missing."""
from __future__ import annotations

from backend.config import Settings


def test_missing_env_cannot_enable_codegen_or_widen_pools(monkeypatch):
    for key in (
        "BUILDER_CODEGEN_ENABLED",
        "RETRIEVAL_WORKERS",
        "DB_POOL_SIZE",
        "GENERATION_MAX_CONCURRENT",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = Settings(_env_file=None)

    assert settings.builder_codegen_enabled is False
    assert settings.retrieval_workers == 2
    assert settings.db_pool_size == 2
    # Keep generation concurrency conservative until a production-sized load
    # test demonstrates that two active model streams do not contend with
    # other database traffic or exceed the deployment's memory budget.
    assert settings.generation_max_concurrent == 1
