"""FastAPI app assembly. Everything substantive lives in its own module.

Run it with ./run.sh, or:
    uvicorn backend.server:app --host 127.0.0.1 --port 8000 --reload
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from . import db, demo, retrieval, service
from .config import settings
from .docx_build import assert_builder_contract
from .deps import COOKIE_NAME, _verify_current
from .errors import AppError, app_error_handler, unhandled_handler
from .ratelimit import limiter, rate_limit_exceeded_handler
from .routes import (
    account,
    admin,
    auth,
    bell_ringer,
    billing,
    canvas,
    classes,
    coaching,
    curriculum,
    drive,
    generate,
    misc,
    onboarding,
    plans,
    quiz_library,
    school_calendars,
    standards,
)
from .schema import SchemaError

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("flexedacademy")

_codegen_worker_task: asyncio.Task | None = None
_CODEGEN_POLL_INTERVAL_S = 15
_DOCUMENT_BUILD_POLL_INTERVAL_S = 2


async def _builder_codegen_worker_loop() -> None:
    """Polls db.claim_next_builder_codegen_job (Postgres FOR UPDATE SKIP
    LOCKED, so multiple app instances polling concurrently never double-claim
    a row) and runs each claimed job to completion. Runs as a background
    asyncio task rather than a separate process — this app is a single
    container, and Postgres is already the coordination point of truth for
    the pool/migrations, so a second broker/queue system would be new
    infrastructure this doesn't need. Each blocking step (DB call, LLM call,
    LibreOffice subprocess) is pushed to the default executor so it never
    stalls the event loop other requests are running on."""
    from .builder.codegen import run_codegen_job

    loop = asyncio.get_running_loop()
    try:
        reset = await loop.run_in_executor(None, db.reset_stale_running_builder_codegen_jobs)
        if reset:
            log.warning("builder codegen: reset %d stale 'running' job(s) back to 'queued' at boot", reset)
    except Exception:
        log.exception("builder codegen: startup staleness sweep failed")

    while True:
        try:
            job = await loop.run_in_executor(None, db.claim_next_builder_codegen_job)
            if job:
                log.info("builder codegen: claimed job %s (school %s)", job["id"], job["school_id"])
                await loop.run_in_executor(None, run_codegen_job, job["id"])
                continue  # a job just finished — check immediately for another, instead of sleeping first
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("builder codegen worker loop: unexpected error")
        await asyncio.sleep(_CODEGEN_POLL_INTERVAL_S)


async def _document_build_worker_loop() -> None:
    loop = asyncio.get_running_loop()
    # Do not let a transient database/DNS failure during startup kill the
    # worker task. The app intentionally stays up when Supabase is briefly
    # unreachable so /api/health can report the problem; the document worker
    # must follow the same policy and keep retrying until the database returns.
    try:
        reset = await loop.run_in_executor(None, db.reset_stale_document_builds)
        if reset:
            log.warning("document build worker: reset %d stale job(s) at boot", reset)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("document build worker: startup database sweep failed; will retry")
    log.info("document build worker loop started")
    while True:
        try:
            job = await loop.run_in_executor(None, db.claim_next_document_build)
            if job:
                log.info("document build worker: claimed plan_id=%s", job["plan_id"])
                await loop.run_in_executor(None, service.run_document_build_job, job)
                continue
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("document build worker: unexpected error")
        await asyncio.sleep(_DOCUMENT_BUILD_POLL_INTERVAL_S)

if settings.sentry_dsn:
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        # AppError is an expected, handled control-flow signal (a 401, a 409
        # for "email taken") with its own {code, message, hint} envelope —
        # reporting every one of those to Sentry would bury the unhandled
        # crashes unhandled_handler exists to catch under routine noise.
        before_send=lambda event, hint: (
            None
            if hint.get("exc_info") and isinstance(hint["exc_info"][1], AppError)
            else event
        ),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Connect eagerly so migrations run at boot, but do not let a database that
    # is merely unreachable stop the app from starting. Refusing to boot means
    # /api/health can't be reached either, so the one endpoint that would tell
    # you what's wrong goes down with it. Every data route re-calls connect() and
    # will surface the same AppError with its hint; health reports pg_error.
    try:
        db.connect()
        if settings.demo_account_enabled:
            try:
                demo.ensure_demo_account()
            except (RuntimeError, ValueError):
                log.exception("recruiter demo account could not be provisioned")
    except Exception as e:  # noqa: BLE001 — an unreachable DB must not stop the app from booting
        log.error(
            "DATABASE UNAVAILABLE AT BOOT: %s — serving anyway; /api/health has details",
            getattr(e, "message", None) or e,
        )
    try:
        # Fail loud at boot if the shared canonical builder drifted. This is the
        # check that would have caught the original v1/v2 template mismatch.
        assert_builder_contract()
    except AppError as e:
        log.error("BUILDER CHECK FAILED: %s — %s", e.message, e.hint or "")
    if not settings.has_api_key:
        log.warning("OPENAI_API_KEY is not set; generation and transcription will fail.")
    # Compared against config.py's ACTUAL default, and against empty.
    #
    # This tested for "dev-only-insecure-secret-set-a-real-one-in-env", a string
    # that appears nowhere else in the codebase — the real default is
    # "dev-secret-do-not-use-in-production" (config.py). So the comparison was
    # always False and this warning could never print. .env.example also ships
    # SESSION_SECRET="", which keys every HMAC with the empty string and was
    # equally unwarned.
    #
    # And a warning is not enough when REQUIRE_LOGIN is on: a forgeable session
    # cookie means anyone can mint a valid login for any account, so a
    # production boot with a default secret should not be a line in a log file
    # nobody is reading. It refuses to start.
    _INSECURE_SECRETS = {
        "",
        "dev-secret-do-not-use-in-production",
        "dev-only-insecure-secret-set-a-real-one-in-env",
    }
    if settings.session_secret.strip() in _INSECURE_SECRETS:
        message = (
            "SESSION_SECRET is unset or still the dev default. The session cookie is a "
            "signed user id, so every teacher's login is forgeable by anyone who knows "
            "this value — and it is in version control."
        )
        if settings.require_login:
            raise RuntimeError(
                message + " Refusing to start with REQUIRE_LOGIN=true. Set a real "
                "SESSION_SECRET (Render: generateValue, or `openssl rand -hex 32`)."
            )
        log.warning("%s Allowed only because REQUIRE_LOGIN is false (local dev).", message)
    # billing_enabled=False is a legitimate, intentional state (entitlement.py:
    # "a gate with no way through it is a broken app") — a free launch, or
    # Stripe not wired up yet, both mean every account generates unmetered.
    # That's fine as a deliberate choice; it's a real spend risk as an
    # ACCIDENTAL one (one missing/typo'd Stripe env var on an otherwise-real
    # production deploy, with no signal anywhere that the paywall never
    # engaged). cookie_secure is this app's own existing "this is really
    # production, not local dev" signal (COOKIE_SECURE=true only in
    # render.yaml) — warn, don't refuse to boot, since unlike SESSION_SECRET
    # there's no unsafe default being silently accepted here, just a cap
    # worth someone's eyes before real usage accrues against it.
    if settings.cookie_secure and not settings.billing_enabled:
        log.warning(
            "BILLING IS NOT ENABLED (billing_enabled=False) on what looks like a "
            "production boot (COOKIE_SECURE=true). Every account generates "
            "unmetered until STRIPE_SECRET_KEY, STRIPE_PRICE_ID, and "
            "STRIPE_WEBHOOK_SECRET are all set. Confirm this is intentional."
        )
    if settings.turnstile_required and not settings.turnstile_configured:
        log.error(
            "TURNSTILE_REQUIRED=true but Turnstile is not fully configured; "
            "anonymous password signups will fail closed until the site key, "
            "secret, and hostnames are set."
        )
    misc.purge_legacy_temp()
    # retrieval.chunk_for_code() — GET /api/standards/{code}, which both the
    # Standards rail panel and every chat citation hit — reads through
    # chunks_by_code() AND _chunks_by_course_and_code(), each an
    # `lru_cache(maxsize=1)` that independently parses every *chunks.json in
    # data/processed/ (~21MB) the first time it's called. Left lazy, that
    # one-time cost landed on whichever teacher's click happened to be first
    # after a boot/redeploy, who watched a blank card for the whole parse.
    # Warming both here, off the request path, pays it during boot instead —
    # in a background thread so it doesn't hold up the app becoming ready.
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, retrieval.chunks_by_code)
    loop.run_in_executor(None, retrieval._chunks_by_course_and_code)

    global _codegen_worker_task
    if settings.builder_codegen_enabled:
        _codegen_worker_task = asyncio.create_task(_builder_codegen_worker_loop())
        log.info("builder codegen worker loop started")

    document_build_worker_task = asyncio.create_task(_document_build_worker_loop())

    # One-time, idempotent repair for the records produced while Weeden's
    # rejected generated spec was incorrectly marked verified.
    loop.run_in_executor(None, service.repair_weeden_plans)

    yield

    if _codegen_worker_task:
        _codegen_worker_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _codegen_worker_task
    document_build_worker_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await document_build_worker_task
    db.close()


class ConditionalGZipMiddleware:
    """GZipMiddleware for everything except the server-sent event streams.

    Starlette's GZipResponder compresses a streaming body chunk by chunk, but
    zlib buffers internally: it emits nothing until a deflate block fills. For
    a normal response that is invisible and worth it. For SSE — where the whole
    point is that a token reaches the browser the moment it exists — it means
    tokens pile up and then arrive several at a time, so a generation that is
    exactly as fast reads as stuttery.

    Keyed on the `_stream` path suffix rather than the response content-type
    because the choice of responder has to be made before the app has said
    anything about what it is returning. Both SSE routes already share that
    suffix (/api/generate_stream, /api/chat_stream), so it doubles as the
    convention to keep: a future streaming route named the same way is
    excluded automatically.
    """

    def __init__(self, app, minimum_size: int = 1024):
        self._plain = app
        self._gzip = GZipMiddleware(app, minimum_size=minimum_size)

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("path", "").endswith("_stream"):
            return await self._plain(scope, receive, send)
        return await self._gzip(scope, receive, send)


class PrivateApiCacheMiddleware:
    """Keep API responses out of browser and intermediary caches.

    Most API responses are account-scoped, and a cache hit after logout or a
    shared-device account switch is a privacy failure even when every route's
    database query is correctly scoped. Applying the header to the complete
    `/api/` surface also covers authenticated error responses and future routes
    without relying on each handler remembering a response option.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not scope.get("path", "").startswith("/api/"):
            return await self.app(scope, receive, send)

        async def send_with_private_cache(message):
            if message.get("type") == "http.response.start":
                headers = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", b"private, no-store"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_private_cache)


class ReadOnlyDemoMiddleware:
    """Make the public showcase read-only across the entire API surface.

    GET/HEAD remain available for browsing plans, citations, and downloads.
    Logout endpoints remain available so the demo is easy to exit; every other
    mutation is refused before it reaches a route or an external API.
    """

    _SAFE_MUTATIONS = {
        "/api/auth/logout",
        "/api/auth/sign_out_everywhere",
    }

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        method = scope.get("method", "GET").upper()
        path = scope.get("path", "")
        if method in {"GET", "HEAD", "OPTIONS"} or path in self._SAFE_MUTATIONS:
            return await self.app(scope, receive, send)

        request = Request(scope, receive=receive)
        user_id = _verify_current(request.cookies.get(COOKIE_NAME))
        user = db.get_user_by_id(user_id) if user_id else None
        if not user or not user.get("is_read_only"):
            return await self.app(scope, receive, send)
        response = JSONResponse(
            status_code=403,
            content={
                "error": {
                    "code": "demo_read_only",
                    "message": (
                        "This demo is read-only. You can browse the seeded "
                        "plans, citations, and artifacts, but changes, generation, "
                        "uploads, sharing, and billing are disabled."
                    ),
                    "hint": "Use the walkthrough or GitHub package for the full engineering context.",
                }
            },
            headers={"Cache-Control": "private, no-store"},
        )
        await response(scope, receive, send)


class SecurityHeadersMiddleware:
    """Add the baseline browser policy required by the SPA and Stripe.js."""

    _CSP = (
        "default-src 'self'; "
        "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; "
        "script-src 'self' 'unsafe-inline' https://js.stripe.com https://accounts.google.com "
        "https://challenges.cloudflare.com; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https://*.stripe.com https://*.link.com "
        "https://accounts.google.com https://challenges.cloudflare.com; "
        "font-src 'self' data:; "
        "connect-src 'self' https://api.stripe.com https://*.stripe.com https://*.link.com "
        "https://accounts.google.com https://challenges.cloudflare.com; "
        "frame-src 'self' https://*.stripe.com https://*.link.com https://accounts.google.com "
        "https://challenges.cloudflare.com"
    )

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)

        async def send_with_security_headers(message):
            if message.get("type") == "http.response.start":
                headers = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() not in {
                        b"content-security-policy",
                        b"x-content-type-options",
                        b"referrer-policy",
                    }
                ]
                headers.extend([
                    (b"content-security-policy", self._CSP.encode()),
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                ])
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_security_headers)


app = FastAPI(title="FlexEd Academy", version="2.0.0", lifespan=lifespan)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# Nothing was compressed before this — not the API's JSON, and not the built
# frontend served further down (a ~900KB JS bundle went out raw on every cold
# visit). minimum_size skips the small stuff, where the gzip header would cost
# more than it saves.
#
# It matters most for route chunks and generated lesson-plan payloads. The
# browser can cache those compressed responses without a second asset pipeline.
#
# NOT applied to the SSE endpoints — see ConditionalGZipMiddleware. zlib holds
# bytes back until a deflate block fills, so wrapping a token-by-token stream
# in gzip makes tokens land in bursts instead of arriving as they're produced:
# the generation is exactly as fast, and visibly feels worse.
app.add_middleware(ConditionalGZipMiddleware, minimum_size=1024)
app.add_middleware(PrivateApiCacheMiddleware)
app.add_middleware(ReadOnlyDemoMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    # Was False, alongside a comment saying nothing here used cookies — now the
    # login session does. This is safe specifically BECAUSE allow_origins is an
    # explicit list, never "*"; browsers reject credentials with a wildcard
    # origin outright, so there's no way to accidentally combine the two.
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)

app.add_exception_handler(AppError, app_error_handler)
app.add_exception_handler(Exception, unhandled_handler)


@app.exception_handler(SchemaError)
async def schema_error_handler(request: Request, exc: SchemaError) -> JSONResponse:
    """A malformed plan is the model's fault, not the server's — 422, with the
    specific field, so the UI can say what went wrong instead of "500"."""
    return JSONResponse(status_code=422, content={"error": exc.payload()})


app.include_router(auth.router)
app.include_router(misc.router)
app.include_router(generate.router)
app.include_router(plans.router)
app.include_router(quiz_library.router)
app.include_router(standards.router)
app.include_router(curriculum.router)
app.include_router(classes.router)
app.include_router(school_calendars.router)
app.include_router(billing.router)
app.include_router(admin.router)
app.include_router(account.router)
app.include_router(drive.router)
app.include_router(canvas.router)
app.include_router(bell_ringer.router)
app.include_router(coaching.router)
app.include_router(onboarding.router)
import os

from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

dist_dir = os.path.join(os.path.dirname(__file__), "../frontend/dist")
assets_dir = os.path.join(dist_dir, "assets")

if os.path.isfile(os.path.join(dist_dir, "index.html")):
    # Backend-only test jobs and API deployments may intentionally omit the
    # frontend build. Check for index.html (the actual SPA contract), not just
    # the parent directory, and only mount assets when that directory exists.
    # Otherwise importing `backend.server` fails during test collection before
    # the API can even report a useful error.
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    # Resolved once, and every candidate path has to stay underneath it.
    dist_root = os.path.realpath(dist_dir)
    # The hashed files under /assets are safe to cache, but index.html names
    # the current bundle. Caching it lets a deployed SPA keep pointing at the
    # previous bundle until a manual refresh, which is exactly the blank-route
    # failure seen when clicking a workspace link after a deploy.
    spa_index_headers = {"Cache-Control": "no-cache, no-store, must-revalidate"}

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve a built asset, else index.html so React Router can route it.

        The containment check below is not defensive programming, it is a fix.
        This handler used to be `os.path.join(dist_dir, full_path)` with no
        validation, and `:path` matches `.*`. uvicorn percent-decodes the request
        target before Starlette routes it and Starlette does not normalise `..`,
        so `GET /%2e%2e/%2e%2e/.env` arrived here as full_path="../../.env" and
        os.path.join resolved it to the project root's .env — which is exactly
        where config.py reads SESSION_SECRET and OPENAI_API_KEY from.

        Measured against the running server before this change: three separate
        encodings each returned HTTP 200 and 1081 bytes of .env. A leaked
        SESSION_SECRET is not one account, it is every account — the session
        cookie is a signed uid, so anyone holding the secret can mint a valid
        cookie for any teacher.

        The /assets mount above is StaticFiles, which has this protection built
        in. Only this hand-rolled sibling was missing it.
        """
        index = os.path.join(dist_root, "index.html")
        if not full_path:
            return FileResponse(index, headers=spa_index_headers)
        candidate = os.path.realpath(os.path.join(dist_root, full_path))
        # os.path.commonpath, not startswith: "/a/dist-secrets" startswith
        # "/a/dist" is True, and realpath resolves symlinks out of the way first.
        inside = candidate == dist_root or os.path.commonpath([candidate, dist_root]) == dist_root
        if inside and os.path.isfile(candidate):
            return FileResponse(candidate)
        # Anything outside the build directory is not "forbidden", it is simply
        # not a file this app serves — so it falls through to the SPA exactly
        # like any other unknown client-side route.
        return FileResponse(index, headers=spa_index_headers)
else:
    @app.get("/")
    def root():
        return {"name": "FlexEd Academy (Frontend not built)", "docs": "/docs"}
