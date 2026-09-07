"""FlexEd's remote MCP server and Apps SDK presentation layer."""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import time
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse, RedirectResponse
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.types import ASGIApp

from . import db, schoolcal, service
from .config import settings
from .deps import get_current_user
from .errors import AppError
from .mcp_auth import MCP_READ_SCOPE, MCP_SCOPES, FlexEdOAuthProvider
from .template_context import day_names_for_school

MCP_BASE_URI = "ui://widget/lesson-plan.html"


def _user_id() -> str:
    access_token = get_access_token()
    user_id = access_token.subject if access_token else None
    if not user_id:
        raise AppError("not_authenticated", "An authenticated FlexEd MCP token is required.", status=401)
    db.current_user_id.set(user_id)
    return user_id


def _class_summary(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row.get("name"),
        "subject": row.get("subject"),
        "grade": row.get("grade"),
        "state": row.get("state"),
        "school": row.get("school"),
    }


def _base_url() -> str:
    return settings.mcp_public_url.rstrip("/") or f"http://localhost:{settings.api_port}"


def artifact_url(user_id: str, plan_id: str) -> str:
    payload = {
        "purpose": "mcp_artifact",
        "uid": user_id,
        "pid": plan_id,
        "exp": int(time.time()) + 15 * 60,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    signature = hmac.new(
        settings.session_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
    ).hexdigest()
    token = f"{encoded}.{signature}"
    return f"{_base_url()}/mcp/artifacts/{quote(token, safe='')}"


def _plan_payload(user_id: str, row: dict) -> dict:
    payload = {
        "plan_id": row["id"],
        "class_id": row.get("class_id"),
        "week_label": row.get("week_label"),
        "unit": row.get("unit"),
        "plan": row.get("plan_json"),
        "warnings": row.get("warnings") or [],
        "retrieved_standard_ids": row.get("retrieved_ids") or [],
        "has_docx": bool(row.get("docx_path")),
    }
    if row.get("docx_path"):
        payload["docx_url"] = artifact_url(user_id, row["id"])
    return payload


def _class_for(user_id: str, class_id: str) -> dict:
    cls = db.get_class(user_id, class_id)
    if not cls or cls.get("archived"):
        raise AppError("class_not_found", "That FlexEd class was not found.", status=404)
    return cls


def _week_query(query: str, school_id: str, week_number: int | None) -> str:
    if week_number is None:
        return query
    week = next((w for w in schoolcal.school_weeks(school_id) if w["week"] == week_number), None)
    if not week:
        raise AppError("week_not_found", f"No school-calendar week {week_number} exists.", status=400)
    return f"Build this for {schoolcal.label_for(week)}. {query.strip()}"


def _transport_security() -> TransportSecuritySettings:
    if settings.mcp_public_url:
        from urllib.parse import urlparse

        host = urlparse(_base_url()).netloc
        return TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[host, f"{host}:*"],
            allowed_origins=[_base_url()],
        )
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["localhost:*", "127.0.0.1:*", "[::1]:*", "testserver"],
        allowed_origins=["http://localhost:*", "http://127.0.0.1:*", "http://testserver"],
    )


oauth_provider = FlexEdOAuthProvider()

mcp = FastMCP(
    "FlexEd Academy",
    instructions=(
        "FlexEd is the teacher's standards-grounded lesson planning system. "
        "Use the teacher's selected class and returned plan data. Never ask for "
        "or invent a user_id; identity comes from the connected FlexEd account."
    ),
    streamable_http_path="/",
    json_response=True,
    stateless_http=True,
    auth_server_provider=oauth_provider,
    auth=AuthSettings(
        issuer_url=f"{_base_url()}/mcp",
        resource_server_url=f"{_base_url()}/mcp/",
        required_scopes=[MCP_READ_SCOPE],
        client_registration_options=ClientRegistrationOptions(
            enabled=True,
            valid_scopes=MCP_SCOPES,
            default_scopes=MCP_SCOPES,
        ),
        revocation_options=RevocationOptions(enabled=True),
    ),
    transport_security=_transport_security(),
)


@mcp.resource(
    MCP_BASE_URI,
    name="lesson-plan-widget",
    description="Renders a generated FlexEd lesson plan inside a compatible chat client.",
    mime_type="text/html+skybridge",
    meta={
        "openai/widgetDescription": "A compact FlexEd lesson-plan card with standards and a DOCX download.",
        "openai/widgetPrefersBorder": True,
    },
)
def lesson_plan_widget() -> str:
    return """<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font:14px system-ui,sans-serif;margin:0;color:#18212f}main{padding:16px}
h2{font-size:18px;margin:0 0 4px}.muted{color:#65748b}.day{border-top:1px solid #e4e9f0;padding:10px 0}
.day h3{font-size:14px;margin:0 0 5px}.label{font-weight:600}.warn{color:#9a5b00}
a{color:#1459b8;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body><main id="app"><div class="muted">Loading plan…</div></main>
<script>
const out=window.openai?.toolOutput||{};const data=out.structuredContent||out;const plan=data.plan||{};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let html=`<h2>${esc(data.week_label||plan.week_of||'Lesson plan')}</h2><div class="muted">${esc(data.unit||plan.unit||'')}</div>`;
if(data.docx_url)html+=`<p><a href="${esc(data.docx_url)}" target="_blank" rel="noreferrer">Download the Word document</a></p>`;
for(const day of(plan.days||[])){html+=`<section class="day"><h3>${esc(day.day||day.name||'Day')}</h3>`;for(const[key,value]of Object.entries(day))if(!['day','name'].includes(key)&&value){const text=Array.isArray(value)?value.join(', '):value;html+=`<div><span class="label">${esc(key.replaceAll('_',' '))}:</span> ${esc(text)}</div>`}html+='</section>'}
if((data.warnings||[]).length)html+=`<p class="warn">${esc(data.warnings.join(' '))}</p>`;document.getElementById('app').innerHTML=html;
</script></body></html>"""


@mcp.tool(
    title="List FlexEd classes",
    description="List the connected teacher's active FlexEd classes.",
    annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False),
    structured_output=True,
)
def list_classes() -> dict[str, Any]:
    user_id = _user_id()
    return {"classes": [_class_summary(row) for row in db.list_classes(user_id)]}


@mcp.tool(
    title="Get FlexEd week context",
    description="Get the selected class, school calendar week, and day names before planning.",
    annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False),
    structured_output=True,
)
def get_week_context(class_id: str, week_number: int | None = None) -> dict[str, Any]:
    user_id = _user_id()
    cls = _class_for(user_id, class_id)
    school_id = db.class_school(cls, user_id)
    weeks = schoolcal.school_weeks(school_id)
    week = next((item for item in weeks if item["week"] == week_number), None) if week_number else None
    return {
        "class": _class_summary(cls),
        "school_id": school_id,
        "week": week,
        "available_weeks": weeks if week_number is None else None,
        "day_names": day_names_for_school(school_id, user_id=user_id),
    }


@mcp.tool(
    title="List FlexEd lesson plans",
    description="List the connected teacher's saved lesson plans, optionally for one class.",
    annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False),
    structured_output=True,
)
def list_lesson_plans(class_id: str | None = None, limit: int = 20) -> dict[str, Any]:
    user_id = _user_id()
    if class_id:
        _class_for(user_id, class_id)
    return db.list_plans(user_id, limit=max(1, min(limit, 50)), class_id=class_id)


@mcp.tool(
    title="Open a FlexEd lesson plan",
    description="Retrieve one saved FlexEd plan and its secure DOCX link if available.",
    annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=False),
    meta={"openai/outputTemplate": MCP_BASE_URI},
    structured_output=True,
)
def get_lesson_plan(plan_id: str) -> dict[str, Any]:
    user_id = _user_id()
    row = db.get_plan(user_id, plan_id)
    if not row:
        raise AppError("plan_not_found", "That lesson plan was not found.", status=404)
    return _plan_payload(user_id, row)


@mcp.tool(
    title="Generate a FlexEd lesson plan",
    description=(
        "Generate and save a standards-grounded lesson plan using FlexEd's calibrated "
        "retrieval, validation, grounding audit, database, and DOCX builder."
    ),
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False),
    meta={"openai/outputTemplate": MCP_BASE_URI},
    structured_output=True,
)
def generate_lesson_plan(
    class_id: str,
    request: str,
    week_number: int | None = None,
) -> dict[str, Any]:
    user_id = _user_id()
    if not request.strip() or len(request) > settings.max_query_chars:
        raise AppError("invalid_request", "The lesson request is empty or too long.", status=400)
    cls = _class_for(user_id, class_id)
    school_id = db.class_school(cls, user_id)
    query = _week_query(request, school_id, week_number)
    row = service.generate(
        user_id,
        query=query,
        class_id=class_id,
        school_id=school_id,
        cls=cls,
        retrieval_query=request,
    )
    return _plan_payload(user_id, row)


@mcp.tool(
    title="Revise a FlexEd lesson-plan day",
    description="Revise one day of a saved FlexEd plan and rebuild its DOCX artifact.",
    annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False),
    meta={"openai/outputTemplate": MCP_BASE_URI},
    structured_output=True,
)
def revise_lesson_day(
    plan_id: str,
    day_index: int,
    feedback: str,
    field: str | None = None,
) -> dict[str, Any]:
    user_id = _user_id()
    if day_index < 0 or not feedback.strip() or len(feedback) > 4000:
        raise AppError("invalid_revision", "Provide a valid day index and revision request.", status=400)
    row = service.revise_day(user_id, plan_id, day_index, feedback.strip(), field=field)
    return _plan_payload(user_id, row)


oauth_router = APIRouter(tags=["mcp"])


def _consent_page(request_id: str) -> HTMLResponse:
    # This value is reflected into a quoted HTML attribute. Use the complete
    # HTML escaping rules rather than a partial replacement list at this OAuth
    # boundary.
    safe_id = html.escape(request_id, quote=True)
    return HTMLResponse(
        """<!doctype html><html><head><title>Connect FlexEd</title>
        <style>body{font:16px system-ui;margin:48px auto;max-width:520px;padding:0 20px;color:#18212f}
        button{background:#1459b8;color:white;border:0;border-radius:6px;padding:10px 16px;font-size:16px}</style>
        </head><body><h1>Connect FlexEd</h1>
        <p>The chat client is requesting access to your FlexEd classes and lesson plans.</p>
        <form method="post" action="/mcp/consent"><input type="hidden" name="request_id" value="""
        + safe_id
        + """"><button type="submit">Approve access</button></form></body></html>"""
    )


@oauth_router.get("/mcp/consent")
def mcp_consent_page(request_id: str, _user_id: str = Depends(get_current_user)):
    if not oauth_provider.pending_request(request_id):
        raise AppError("oauth_request_expired", "This authorization request has expired.", status=404)
    return _consent_page(request_id)


@oauth_router.post("/mcp/consent")
def mcp_consent_approve(request_id: str, user_id: str = Depends(get_current_user)):
    try:
        redirect_url = oauth_provider.approve(request_id, user_id)
    except ValueError as exc:
        raise AppError("oauth_request_expired", str(exc), status=400) from exc
    return RedirectResponse(redirect_url, status_code=302)


def build_mcp_app() -> ASGIApp:
    return mcp.streamable_http_app()


mcp_app = build_mcp_app()
