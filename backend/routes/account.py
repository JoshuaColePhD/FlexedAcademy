"""Self-service account actions that aren't really about any one class —
exporting what a teacher put into the app, and (eventually) deleting the
account itself. Split from routes/auth.py because those are about the
session; these are about the data underneath it.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, Response

from .. import db
from ..deps import get_current_user

log = logging.getLogger("flexedacademy.account")

router = APIRouter(prefix="/api/account", tags=["account"])


@router.get("/export")
def export_data(user_id: str = Depends(get_current_user)):
    """Every row this teacher created, as one downloadable JSON file — settings,
    classes, plans and their feedback, chats and their messages, curriculum
    maps and their progress. See db.export_user_data for exactly what's
    included and why (and what's deliberately left out).
    """
    data = db.export_user_data(user_id)
    db.record_audit_log(user_id, "account.export", target_user_id=user_id)
    return Response(
        content=json.dumps(data, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=flexed-academy-export.json"},
    )
