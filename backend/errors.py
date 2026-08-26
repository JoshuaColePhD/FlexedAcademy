"""One error shape for the whole API.

Before this, handlers did `except Exception as e: detail=str(e)`, which leaked
absolute filesystem paths and raw OpenAI error text to the browser, and in
/api/generate swallowed its own HTTPException and re-wrapped it as
`500: "500: Docx file was not created."`. Every error now carries a stable
machine-readable `code` the frontend can branch on, plus an optional `hint`
that tells the user what to actually do.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import Request
from fastapi.responses import JSONResponse

log = logging.getLogger("flexedacademy")


class AppError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 500,
        hint: str | None = None,
        extra: dict | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.hint = hint
        self.extra = extra or {}

    def payload(self) -> dict:
        body: dict = {"code": self.code, "message": self.message}
        if self.hint:
            body["hint"] = self.hint
        body.update(self.extra)
        return {"error": body}


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    log.warning("app_error code=%s status=%s msg=%s", exc.code, exc.status, exc.message)
    return JSONResponse(status_code=exc.status, content=exc.payload())


async def unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log the detail server-side; tell the client only that it broke."""
    request_id = uuid.uuid4().hex[:12]
    log.exception("unhandled request_id=%s path=%s", request_id, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "internal_error",
                "message": "Something went wrong on the server.",
                "request_id": request_id,
                "hint": "Check the server log for this request_id.",
            }
        },
    )
