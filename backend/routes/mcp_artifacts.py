"""Secure short-lived DOCX links returned by the MCP tools."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

from .. import db, docx_build, storage
from ..config import settings
from ..errors import AppError

router = APIRouter(tags=["mcp"])


def _decode(token: str) -> dict | None:
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(
            settings.session_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("purpose") != "mcp_artifact" or int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


@router.get("/mcp/artifacts/{token}")
def download_mcp_artifact(token: str):
    payload = _decode(token)
    if not payload:
        raise AppError("artifact_expired", "This document link has expired.", status=404)
    user_id = str(payload["uid"])
    plan = db.get_plan(user_id, str(payload["pid"]))
    if not plan or not plan.get("docx_path"):
        raise AppError("artifact_missing", "This lesson plan does not have a document yet.", status=404)
    path = Path(plan["docx_path"]).resolve()
    plans_root = Path(settings.plans_dir).resolve()
    if not path.is_relative_to(plans_root) or not storage.ensure_local(path) or not docx_build.is_valid_docx(path):
        raise AppError("artifact_missing", "The lesson-plan document is unavailable.", status=404)
    return FileResponse(
        str(path),
        filename=f"{docx_build.safe_filename(plan.get('week_label') or 'lesson-plan')}.docx",
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
