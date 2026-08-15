"""FastAPI app assembly. Everything substantive lives in its own module.

Run it with ./run.sh, or:
    uvicorn backend.server:app --host 127.0.0.1 --port 8000 --reload
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import db
from .config import settings
from .docx_build import assert_builder_contract
from .errors import AppError, app_error_handler, unhandled_handler
from .routes import account, admin, auth, bell_ringer, billing, classes, curriculum, generate, misc, plans, standards
from .schema import SchemaError

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("aplang")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Connect eagerly so migrations run at boot, but do not let a database that
    # is merely unreachable stop the app from starting. Refusing to boot means
    # /api/health can't be reached either, so the one endpoint that would tell
    # you what's wrong goes down with it. Every data route re-calls connect() and
    # will surface the same AppError with its hint; health reports pg_error.
    try:
        db.connect()
    except Exception as e:
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
    if settings.session_secret == "dev-only-insecure-secret-set-a-real-one-in-env":
        log.warning(
            "SESSION_SECRET is not set — using the insecure dev default. Every "
            "login session cookie is forgeable until a real one is set in .env."
        )
    misc.purge_legacy_temp()
    yield
    db.close()


app = FastAPI(title="AP Lang RAG", version="2.0.0", lifespan=lifespan)

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
app.include_router(billing.router)
app.include_router(admin.router)
app.include_router(account.router)
app.include_router(bell_ringer.router)
import os
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

dist_dir = os.path.join(os.path.dirname(__file__), "../frontend/dist")

if os.path.isdir(dist_dir):
    app.mount("/assets", StaticFiles(directory=os.path.join(dist_dir, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # Serve exact file if it exists (e.g. favicon.ico, images)
        file_path = os.path.join(dist_dir, full_path)
        if full_path and os.path.isfile(file_path):
            return FileResponse(file_path)
        # Otherwise serve index.html for React Router
        return FileResponse(os.path.join(dist_dir, "index.html"))
else:
    @app.get("/")
    def root():
        return {"name": "AP Lang RAG (Frontend not built)", "docs": "/docs"}
