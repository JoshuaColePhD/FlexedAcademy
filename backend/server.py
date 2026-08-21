"""FastAPI app assembly. Everything substantive lives in its own module.

Run it with ./run.sh, or:
    uvicorn backend.server:app --host 127.0.0.1 --port 8000 --reload
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from . import db
from .config import settings
from .docx_build import assert_builder_contract
from .errors import AppError, app_error_handler, unhandled_handler
from .ratelimit import limiter, rate_limit_exceeded_handler
from .routes import (
    account,
    admin,
    auth,
    billing,
    canvas,
    classes,
    curriculum,
    drive,
    generate,
    misc,
    plans,
    school_calendars,
    standards,
)
from .schema import SchemaError

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("aplang")

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
    misc.purge_legacy_temp()
    yield
    db.close()


app = FastAPI(title="AP Lang RAG", version="2.0.0", lifespan=lifespan)

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
app.add_middleware(GZipMiddleware, minimum_size=1024)

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
app.include_router(standards.router)
app.include_router(curriculum.router)
app.include_router(classes.router)
app.include_router(school_calendars.router)
app.include_router(billing.router)
app.include_router(admin.router)
app.include_router(account.router)
app.include_router(drive.router)
app.include_router(canvas.router)
import os

from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

dist_dir = os.path.join(os.path.dirname(__file__), "../frontend/dist")

if os.path.isdir(dist_dir):
    app.mount("/assets", StaticFiles(directory=os.path.join(dist_dir, "assets")), name="assets")

    # Resolved once, and every candidate path has to stay underneath it.
    dist_root = os.path.realpath(dist_dir)

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
            return FileResponse(index)
        candidate = os.path.realpath(os.path.join(dist_root, full_path))
        # os.path.commonpath, not startswith: "/a/dist-secrets" startswith
        # "/a/dist" is True, and realpath resolves symlinks out of the way first.
        inside = candidate == dist_root or os.path.commonpath([candidate, dist_root]) == dist_root
        if inside and os.path.isfile(candidate):
            return FileResponse(candidate)
        # Anything outside the build directory is not "forbidden", it is simply
        # not a file this app serves — so it falls through to the SPA exactly
        # like any other unknown client-side route.
        return FileResponse(index)
else:
    @app.get("/")
    def root():
        return {"name": "AP Lang RAG (Frontend not built)", "docs": "/docs"}
