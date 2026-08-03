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
from .routes import generate, misc, plans, standards
from .schema import SchemaError

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)
log = logging.getLogger("aplang")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.connect()
    try:
        # Fail loud at boot if the shared canonical builder drifted. This is the
        # check that would have caught the original v1/v2 template mismatch.
        assert_builder_contract()
    except AppError as e:
        log.error("BUILDER CHECK FAILED: %s — %s", e.message, e.hint or "")
    if not settings.has_api_key:
        log.warning("OPENAI_API_KEY is not set; generation and transcription will fail.")
    misc.purge_legacy_temp()
    yield
    db.close()


app = FastAPI(title="AP Lang RAG", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    # Was True alongside allow_origins=["*"], a combination browsers reject
    # outright — so credentialed CORS never actually worked. Nothing here uses
    # cookies, so it stays off.
    allow_credentials=False,
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


app.include_router(misc.router)
app.include_router(generate.router)
app.include_router(plans.router)
app.include_router(standards.router)


@app.get("/")
def root():
    return {"name": "AP Lang RAG", "docs": "/docs", "health": "/api/health"}
