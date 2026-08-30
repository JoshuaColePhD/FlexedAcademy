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
    openai_model: str = "gpt-5.6-luna"
    common_standards_api_key: str = ""

    # ── voice replies ────────────────────────────────────────────────────────
    # gpt-4o-mini-tts, not tts-1: OpenAI's own guidance names this the model for
    # realtime use, and it supports streaming the audio out over chunked
    # transfer (see llm.stream_speech) where tts-1 was being read into memory
    # whole before anything could play. Still the cheap tier — tts-1-hd remains
    # the wrong trade for what these are: short spoken chat confirmations, not
    # narration.
    tts_model: str = "gpt-4o-mini-tts"
    tts_voice: str = "alloy"
    # A chat reply is a sentence or two by construction (see ChatPage's
    # "Built {week}. Tell me what to change…"). This is a cost/abuse floor,
    # not a real limit anything should ever hit.
    max_tts_chars: int = 2000

    # ── live voice mode (WebRTC realtime session) ───────────────────────────
    # Was two hardcoded module constants in routes/generate.py — a model bump
    # needed a code deploy like nowhere else in this app configures an OpenAI
    # model. Both the ephemeral-key mint and the browser's own SDP POST have
    # to agree on the model; generate.py's voice_session hands this value
    # back in its response so there's still one source of truth, just a
    # configurable one now.
    realtime_model: str = "gpt-realtime-2.1"
    realtime_voice: str = "alloy"
    realtime_session_timeout_s: float = 10.0

    # ── email (password reset) ────────────────────────────────────────────────
    # Resend's HTTP API — no SDK, just a POST via `requests`, which is already
    # a dependency. Inert until the key is set: forgot-password degrades to
    # "no email actually sent" (logged, not raised) rather than a 500 — the
    # same inert-until-configured shape Stripe uses below.
    resend_api_key: str = ""
    # Resend's own sandbox address. Works with zero setup, but only delivers
    # to the inbox that owns the API key until a real sending domain is
    # verified in the Resend dashboard and this is pointed at it.
    email_from: str = "FlexEd Academy <onboarding@resend.dev>"

    # ── billing ──────────────────────────────────────────────────────────────
    # Unlimited plans; the free tier is capped on actual API spend instead. The
    # rule lives in exactly one place: backend/entitlement.py.
    #
    # The gate is INERT until all three are set. That is not caution for its own
    # sake: the moment a gate ships without a way through it, every existing
    # account is locked out of an app they were using — this one already has an
    # account with seven plans. No keys, no gate, and the app behaves exactly as
    # it does today.
    #
    # The price is never hardcoded in the UI. It is read from Stripe at runtime
    # (routes/billing.py) so the number a teacher sees is the number that will
    # be charged, and changing it is a Stripe dashboard edit, not a deploy.
    stripe_secret_key: str = ""
    stripe_price_id: str = ""
    stripe_webhook_secret: str = ""
    # Where Stripe sends them back to. Empty = derive from the request.
    billing_return_url: str = ""
    # How long a new account may use the app for free, with no card, before
    # entitlement.py's trial_expired cuts it off and Checkout becomes the only
    # way back in. This is enforced app-side from users.created_at, not by
    # Stripe. Checkout deliberately sends no Stripe trial: the free week has
    # already happened, so the first successful subscription payment is due
    # immediately.
    trial_period_days: int = 7

    # ── Google Drive sharing ─────────────────────────────────────────────────
    # Same inert-until-configured shape as Stripe/Resend above: with either of
    # these empty, drive_share_enabled is False and the whole feature just
    # doesn't offer itself — no gate anyone can trip, no error anyone can hit.
    #
    # google_client_id (above, existing) is already used for Sign-In-with-
    # Google, which only proves who someone is — it carries no Drive
    # permission at all. Sharing needs the app to actually CREATE and PERMISSION
    # a file on a teacher's own Drive, which is a different, much bigger ask
    # of Google than "tell me who's signing in": a real OAuth authorization-
    # code exchange, which is what google_client_secret is for. The two only
    # share a name because they're issued from the same Google Cloud project.
    #
    # Scope requested is drive.file — the file this app creates and nothing
    # else already in the teacher's Drive. That's the least Google offers, and
    # it's still enough that a school's Google Workspace admin may need to
    # approve this app before any teacher in that domain can use it; that
    # approval lives in Google's admin console, not in this app.
    google_client_secret: str = ""
    # Where Google redirects back to after consent. Empty = derive from the
    # request, same fallback billing_return_url uses — set this in production
    # so the redirect URI matches exactly what's registered in Google Cloud
    # Console (Google rejects a mismatch outright).
    drive_redirect_url: str = ""

    # Replaces "one free plan, ever": that gated on plan COUNT, so revising the
    # same week fifteen times cost nothing extra while building two short weeks
    # used the whole allowance — the thing actually being protected (API spend)
    # was never what was being measured. This measures it directly: every
    # model call records its real input+output tokens (db.record_usage), and
    # entitlement.py sums the trailing 7 days of them against one of these two
    # caps — the same shape ChatGPT/Claude free tiers use, just not surfaced to
    # a teacher as a raw token count.
    #
    # ~150k tokens/week is generous headroom for normal use — a full week
    # generation plus its retrieval context runs well under 10k tokens, so
    # this covers a dozen-plus builds and revisions before it bites, not "one
    # week, ever." Rough ceiling at gpt-4o's own pricing: well under $5/week
    # even maxed out.
    free_weekly_token_cap: int = 20_000
    # Sized to a dollar budget, not a round token count — the previous
    # 2,000,000 was "a safety net, not a real limit anything should hit," but
    # nothing else actually bounded how fast an account could reach it:
    # generate.py's own rate limit (20-30 requests/minute) still lets a
    # scripted caller burn 2M tokens in well under 15 minutes, every single
    # week. At the gpt-4o-era blended rate free_weekly_token_cap's own
    # comment already leans on (~$5/1M tokens, mixed input/output), that was
    # $35-75/month in worst-case API spend against $11.99 of revenue — a
    # guaranteed loss on any account that actually hit it, not a remote edge
    # case.
    #
    # 110,000/week keeps worst-case spend (maxed out, every week, all month)
    # at roughly 20% of $11.99 — a COGS ceiling, not the number normal use is
    # expected to approach. A real subscriber planning several classes runs
    # nowhere near this any more than they ran near the old 2M; this just
    # means an account that DOES hit it costs at most ~$2.40/month instead of
    # ~$50, whoever or whatever is behind it. Revisit the $5/1M assumption
    # and this number together if the configured model's real per-token
    # price changes — the ratio is what matters, not the literal count.
    subscriber_weekly_token_cap: int = 200_000

    database_url: str = ""
    # Optional Supabase Storage mirror for generated files and uploads. Local
    # disk remains the development fallback; production should set all three.
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    storage_bucket: str = "flexed-academy"
    curriculum_maps_dir: Path = PROJECT_ROOT / "data" / "curriculum_maps"
    plans_dir: Path = PROJECT_ROOT / "plans"
    chunks_path: Path = PROJECT_ROOT / "data" / "processed" / "chunks.json"
    known_gaps_path: Path = PROJECT_ROOT / "data" / "raw" / "KNOWN_GAPS.md"
    builder_path: Path = DEFAULT_BUILDER
    # docx_build.builder() falls back to builder_path (Florence's own AP-Lang
    # builder) when a school has no `{school_id}_builder.py` of its own —
    # correct ONLY for the one school that IS Florence, since builder_path
    # literally is Florence's builder. Naming it here (instead of assuming
    # "no custom file found" always means "use Florence's") is what lets
    # docx_build.py tell "Florence, intentionally" apart from "some other
    # school marked active with nothing actually built for it yet" and raise
    # loudly for the latter instead of silently mis-rendering.
    default_builder_school_id: str = "florence-high-school"

    # Automated builder codegen (backend/builder/codegen.py) — generates and
    # visually verifies a declarative layout spec for a new school instead of
    # requiring a hand-written {school_id}_builder.py. Turned on 2026-08-26
    # for the staged, one-school-at-a-time pilot the comment above always
    # described — generic_renderer.py's cell_source shape bug (the one that
    # would have KeyError'd on the first real generated spec) is fixed and
    # covered by backend/builder/test_generic_renderer.py now, so this is
    # safe to leave live: turning it on only starts an idle worker loop
    # (backend/server.py's _builder_codegen_worker_loop) that polls for
    # queued jobs and does nothing until a real template upload's analysis
    # succeeds (template_intake.run_and_persist is the only enqueue point).
    # No school currently in `schools` has gotten that far yet (all
    # template_status='pending'), so this has zero cost or behavior change
    # today — it just means the NEXT real school template upload actually
    # gets carried through instead of silently doing nothing. Still gated
    # behind mandatory admin approval before any generated spec reaches a
    # teacher (routes/admin.py's /builder-codegen/{job_id}/approve).
    builder_codegen_enabled: bool = True
    # Generous enough for a real spec to converge after review feedback,
    # small enough to bound cost — this runs once per school onboarding, not
    # per document generation, so a few minutes of wall-clock is acceptable.
    builder_codegen_max_attempts: int = 4
    # A ceiling independent of any one job's own attempt cap — jobs are
    # enqueued from template uploads (template_intake.run_and_persist), not
    # gated by entitlement.py at all (that gate is per-teacher spend on plan
    # generation; a codegen job belongs to a school's onboarding, not a
    # generation a specific teacher asked for). Without this, a bug that
    # re-queues jobs, or an admin re-triggering retries in a loop, has no
    # ceiling: up to builder_codegen_max_attempts attempts x 2 vision-judge
    # calls x 1 generation call each, with no upper bound on how many JOBS
    # can start in a day. This bounds worst case to
    # builder_codegen_max_jobs_per_day x (up to ~12 OpenAI calls).
    builder_codegen_max_jobs_per_day: int = 5
    skill_context_path: Path = Path(__file__).resolve().parent / "context" / "ap_lang_rules.md"
    school_profile_path: Path = Path(__file__).resolve().parent / "context" / "school_profile.md"
    # One calendar file per registered school (backend/db.py's `schools` table),
    # named by the school's own id: <calendars_dir>/<id>.md. No separate path
    # column on that table — the id doubling as the filename means there's one
    # string to keep in sync, not two that can drift apart.
    calendars_dir: Path = Path(__file__).resolve().parent / "context" / "calendars"

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

    # How many retrieval queries may be IN FLIGHT at once.
    #
    # This is a MEMORY bound, not a throughput one. One generation issues ~30
    # pgvector reads (6 query phrasings x 5 strata), and each in-flight hybrid
    # query transiently holds 50-135MB while psycopg2 buffers the RRF join.
    # At 8 that peaked at 550MB-1.0GB depending on how many happened to overlap
    # — over Render's 512MB, so the worker was OOM-killed mid-stream and the
    # browser saw a 502 with no error event. Measured 2026-08-07.
    #
    # Lower is also FASTER here: 30 jobs took 5.0s at 8 workers and 2.3s at 2,
    # because the workers were contending for a pool of the same size and for
    # Supabase's pooler behind it. Concurrency past the pool buys nothing.
    # 2, not 3: the ceiling has to hold when two teachers generate at the SAME
    # time, not just for one request in isolation. Raise it if the service moves
    # off a 512MB instance.
    retrieval_workers: int = 2

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

    # Error tracking. Inert until set — same inert-until-configured shape as
    # Stripe and Resend above, since a dev machine shouldn't report its own
    # tracebacks to a shared Sentry project.
    sentry_dsn: str = ""
    sentry_environment: str = "development"

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
            logging.getLogger("flexedacademy.config").warning(
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

    @property
    def billing_enabled(self) -> bool:
        """Whether the paywall is live.

        All three, because a gate you cannot pay through is just a broken app:
        the secret key to talk to Stripe, the price to charge, and the webhook
        secret to hear back that they paid. Missing any one of them and
        entitlement() lets everyone through.
        """
        return bool(self.stripe_secret_key and self.stripe_price_id and self.stripe_webhook_secret)

    @property
    def drive_share_enabled(self) -> bool:
        """Whether "Share via Google" can actually do anything.

        google_client_id alone (used for Sign-In-with-Google) is not enough —
        that flow never asks for Drive access. This is True only once the
        secret half of a real OAuth client is also configured.
        """
        return bool(self.google_client_id and self.google_client_secret)

    def floor_for(self, course: str | None) -> float:
        """The relevance floor for one course, falling back to the global one."""
        if course and course in self.retrieval_floors:
            return float(self.retrieval_floors[course])
        return self.retrieval_max_distance


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
