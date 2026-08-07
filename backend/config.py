"""Typed configuration. Every env var lands here, validated at import.

This module is the seam a future deploy swaps: change the paths here and
nothing else needs to know where things live.
"""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_BUILDER = (
    PROJECT_ROOT / "backend" / "builder" / "build_lesson_plan.py"
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
    return base / "flexed-academy" / "app.db"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    openai_api_key: str = ""
    openai_model: str = "gpt-4o"
    common_standards_api_key: str = ""

    database_url: str = ""
    curriculum_maps_dir: Path = PROJECT_ROOT / "data" / "curriculum_maps"
    plans_dir: Path = PROJECT_ROOT / "plans"
    chunks_path: Path = PROJECT_ROOT / "data" / "processed" / "chunks.json"
    known_gaps_path: Path = PROJECT_ROOT / "data" / "raw" / "KNOWN_GAPS.md"
    builder_path: Path = DEFAULT_BUILDER
    skill_context_path: Path = Path(__file__).resolve().parent / "context" / "ap_lang_rules.md"
    school_profile_path: Path = Path(__file__).resolve().parent / "context" / "school_profile.md"
    # The global school calendar for Florence City Schools, applying to all courses.
    calendar_path: Path = Path(__file__).resolve().parent / "context" / "school_calendar.md"

    retrieval_top_k: int = 5
    # MEASURED, NOT GUESSED — and specific to the embedding model.
    #
    # Re-measured 2026-08-05 with scripts/06_threshold_sweep.py after the corpus
    # moved from all-MiniLM-L6-v2 (Chroma, L2) to text-embedding-3-small at 384
    # dims (pgvector, cosine), for AP_Lang grade 11:
    #
    #     hardest in-domain query   0.604   (must be kept)
    #     nearest off-domain query  0.689   ("asdf qwerty zxcv")
    #     viable band               0.604 .. 0.689
    #     chosen                    0.65    (midpoint, maximum margin both ways)
    #
    # At 0.65: 11/11 in-domain kept, 6/6 off-domain rejected.
    #
    # The previous value was 0.78, carried over from MiniLM. In this space that
    # is well above the off-domain floor — gibberish (0.689), "solve quadratic
    # equations by factoring" (0.775), "photosynthesis lab" (0.708) and "AP
    # Calculus BC derivatives" (0.708) would all have passed and been answered
    # from the nearest AP Lang standards. The floor IS the off-domain guarantee,
    # so re-run the sweep after ANY change to the model, dimensions or chunking.
    #
    # NOTE: this figure is AP_Lang's. Other courses were never swept in this
    # space; see retrieval_floors_raw below.
    retrieval_max_distance: float = 0.65
    # Per-course overrides, as JSON: {"Math": 0.62}.
    #
    # The 0.78 above was measured against AP Lang and does NOT transfer to the
    # Alabama frameworks. Re-measured 2026-08-04 on the grade 9-12 corpus, nearest
    # off-domain match per framework: Health 0.884, Counseling 0.884, Social
    # Studies 0.875, Arts 0.858, AP Lang 0.838, ELA 0.838, DLCS 0.827,
    # Math_AWF 0.827, World Languages 0.812 — all safely outside 0.78 — but
    # Math 0.746, Science 0.752 and PE 0.762, all INSIDE it.
    #
    # (PE was outside at 0.887 while K-8 was loaded and moved inside when the
    # corpus narrowed to high school. The floor is a property of the corpus, not
    # of the subject — re-measure after ANY change to grade scope or chunking.)
    #
    # Deliberately left empty rather than guessed at. For those three the viable
    # band is now wide — in-domain tops out at 0.47 — so ~0.60 would likely work,
    # but that is two probe queries per subject, and AP Lang has legitimate
    # in-domain phrasing out at 0.73. Run
    #   scripts/06_threshold_sweep.py --course Math --grade 11
    # with real teacher phrasings and put the measured number here.
    # See KNOWN_GAPS.md.
    #
    # Held as a string and parsed in `retrieval_floors`, NOT typed as dict here.
    # pydantic-settings json.loads()es complex-typed fields inside the env source,
    # before any validator can normalise them, so RETRIEVAL_FLOORS="" — which is
    # exactly what copying .env.example gives you, since every other setting there
    # uses "" for unset — raised JSONDecodeError and took the app down at import.
    retrieval_floors_raw: str = Field(default="", alias="RETRIEVAL_FLOORS")

    # A SEPARATE, looser floor for the ACT companion stratum only.
    #
    # The floor above answers "is this query in our domain at all", and distance
    # is the only signal it has. The ACT companion asks something different: of
    # the ACT standards this course's students will actually be tested on, which
    # is closest to this week? Subject correctness there is guaranteed
    # STRUCTURALLY, by retrieval.act_sections_for() — a physics week can only
    # ever see ACT Science — so distance is not carrying that weight and does not
    # need to be tight.
    #
    # And a cross-walk alignment is semantically distant by nature. Measured
    # 2026-08-06, best correctly-sectioned ACT match per course:
    #
    #     AP Physics 1     S.EMI.501  0.575      AP World History  R.ARG.401 0.664
    #     AP Physics C     S.IOD.701  0.651      AP European Hist  R.ARG.701 0.683
    #     Pre-AP Chemistry S.IOD.601  0.661      AP Calculus       M.IES.301 0.703
    #     AP US History    R.ARG.301  0.709      AP Psychology     R.REL.501 0.726
    #     AP Macroecon     R.ARG.601  0.757      AP Human Geog     R.ARG.601 0.777
    #     Social Studies   R.IDT.201  0.805      AP Gov & Politics R.ARG.701 0.831
    #
    # Every one of those is apt — a document-sourcing week matching ACT Reading's
    # Arguments strand, a related-rates week matching Integrating Essential
    # Skills — and at 0.65 all but one were thrown away, leaving the ACT row
    # empty for every history and social studies course. 0.85 admits them.
    #
    # This CANNOT re-open the off-domain hole the floor above closes: an ACT
    # chunk is only ever kept alongside a primary standard that passed the
    # strict floor (see retrieve_grounded). A chemistry query against AP Lang
    # still retrieves nothing and is still refused.
    act_max_distance: float = 0.85
    # Below this many surviving chunks, the generator is told to say so rather
    # than supply a code from memory.
    retrieval_thin_threshold: int = 3

    # Signs the login session cookie (see auth.py). Any value works for local
    # dev — every existing session just invalidates if it changes — but a real
    # shared deployment MUST override this via .env, or every server restart
    # (a fresh random key) logs every teacher out, and worse, a guessable
    # default would let anyone forge another teacher's session cookie.
    # Connections per process. The app previously shared ONE connection behind a
    # global lock, which serialised every query across every user — nine
    # concurrent reads measured 1.36x faster than nine sequential ones. A pool is
    # what lets two teachers generate at once.
    #
    # Small on purpose: the app may run as several processes (or several warm
    # serverless instances), each with its own pool, and Supabase's pooler has a
    # ceiling. 8 x a few processes stays well inside it, and the work is
    # I/O-bound on OpenAI rather than on Postgres.
    db_pool_size: int = 8

    session_secret: str = "dev-secret-do-not-use-in-production"

    # With this False, get_current_user() returns 'default_user' for any request
    # with no valid session cookie instead of a 401 — everyone unauthenticated
    # shares one account and its data. It exists as a local-iteration escape
    # hatch and must stay True anywhere more than one person can reach.
    require_login: bool = True

    # Marks the session cookie Secure, so a browser will only ever send it over
    # HTTPS. Off by default because local dev is plain http://127.0.0.1 and a
    # Secure cookie would never be sent there at all; render.yaml sets it true.
    # Without it in production the session token is sendable in plaintext.
    cookie_secure: bool = False

    google_client_id: str | None = None

    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5175,http://127.0.0.1:5175"
    # 8000 is taken on this machine by the local oMLX LLM server, so the app
    # lives on 8010 by default.
    api_port: int = 8010
    log_level: str = "INFO"

    max_audio_bytes: int = 25 * 1024 * 1024  # Whisper's own cap
    max_doc_bytes: int = 10 * 1024 * 1024
    max_query_chars: int = 8000

    @field_validator("allowed_origins")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @property
    def retrieval_floors(self) -> dict[str, float]:
        """Per-course floor overrides. Malformed JSON is ignored, loudly.

        A bad value here must not stop the app from starting — the global floor is
        a safe fallback, and a teacher mid-lesson-plan should not meet a stack
        trace over a tuning override.
        """
        raw = (self.retrieval_floors_raw or "").strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
            return {str(k): float(v) for k, v in parsed.items()}
        except (ValueError, TypeError, AttributeError):
            logging.getLogger("aplang.config").warning(
                "RETRIEVAL_FLOORS is not a JSON object of course->float (%r); "
                "ignoring it and using RETRIEVAL_MAX_DISTANCE=%.2f for every course.",
                raw, self.retrieval_max_distance,
            )
            return {}

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def has_api_key(self) -> bool:
        return bool(self.openai_api_key) and self.openai_api_key != "your-api-key-here"

    def floor_for(self, course: str | None) -> float:
        """The relevance floor for one course, falling back to the global one."""
        if course and course in self.retrieval_floors:
            return float(self.retrieval_floors[course])
        return self.retrieval_max_distance


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
