"""Typed configuration. Every env var lands here, validated at import.

This module is the seam a future deploy swaps: change the paths here and
nothing else needs to know where things live.
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# The canonical Florence City Schools builder. Lives OUTSIDE this repo, shared
# with the build-lesson-plan skill. Never fork it — see docx_build.py.
DEFAULT_BUILDER = (
    PROJECT_ROOT.parents[2] / "Skills" / "build-lesson-plan" / "scripts" / "build_lesson_plan.py"
)


def _default_db_path() -> Path:
    """Deliberately NOT inside the repo.

    The repo lives in Google Drive. SQLite in WAL mode keeps -wal and -shm
    sidecars that must stay mutually consistent with the main file; Drive
    uploads them independently and creates "app.db (1)" on any perceived
    conflict. chroma_db/chroma.sqlite3 survives in Drive only because it is
    effectively read-only and fully rebuildable. app.db holds the only
    irreplaceable data in this project, so it goes outside the synced tree.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / "Library" / "Application Support"
    return base / "ap-lang-rag" / "app.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    app_db_path: Path = Field(default_factory=_default_db_path)
    plans_dir: Path = PROJECT_ROOT / "plans"
    chroma_path: Path = PROJECT_ROOT / "chroma_db"
    chunks_path: Path = PROJECT_ROOT / "chunks.json"
    known_gaps_path: Path = PROJECT_ROOT / "source_docs" / "KNOWN_GAPS.md"
    builder_path: Path = DEFAULT_BUILDER
    skill_context_path: Path = Path(__file__).resolve().parent / "context" / "ap_lang_rules.md"

    retrieval_top_k: int = 5
    # Tuned empirically for all-MiniLM-L6-v2 + Chroma's default L2 space via
    # scripts/06_threshold_sweep.py. In-domain queries top out at ~0.73
    # (jargon-heavy ones like "Week 3 SPACE CAT analysis of Letter from
    # Birmingham Jail" sit at 0.71); off-domain starts at ~0.82. This number is
    # MEANINGLESS if the embedding model or chunking changes — re-run the sweep.
    retrieval_max_distance: float = 0.78
    # Below this many surviving chunks, the generator is told to say so rather
    # than supply a code from memory.
    retrieval_thin_threshold: int = 3

    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    api_port: int = 8000
    log_level: str = "INFO"

    max_audio_bytes: int = 25 * 1024 * 1024  # Whisper's own cap
    max_doc_bytes: int = 10 * 1024 * 1024
    max_query_chars: int = 8000

    @field_validator("allowed_origins")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def has_api_key(self) -> bool:
        return bool(self.openai_api_key) and self.openai_api_key != "your-api-key-here"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
