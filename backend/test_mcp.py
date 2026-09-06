from __future__ import annotations

import asyncio

from mcp.server.auth.provider import AuthorizationParams
from mcp.shared.auth import OAuthClientInformationFull
from pydantic import AnyUrl

from backend import mcp_auth, mcp_server
from backend.routes import mcp_artifacts


def test_signed_mcp_token_is_revoked_with_session_version(monkeypatch):
    monkeypatch.setattr(mcp_auth.settings, "session_secret", "test-secret")
    user = {"id": "teacher-1", "session_version": 3, "is_blocked": False}
    monkeypatch.setattr(mcp_auth.db, "get_user_by_id", lambda user_id: user if user_id == user["id"] else None)

    token = mcp_auth.create_mcp_access_token(user["id"])["access_token"]
    verified = asyncio.run(mcp_auth.FlexEdOAuthProvider().load_access_token(token))
    assert verified is not None
    assert verified.subject == user["id"]

    user["session_version"] = 4
    assert asyncio.run(mcp_auth.FlexEdOAuthProvider().load_access_token(token)) is None


def test_oauth_code_exchange_is_one_time(monkeypatch):
    user = {"id": "teacher-1", "session_version": 0, "is_blocked": False}
    monkeypatch.setattr(mcp_auth.db, "get_user_by_id", lambda user_id: user if user_id == user["id"] else None)
    provider = mcp_auth.FlexEdOAuthProvider()

    async def scenario():
        client = OAuthClientInformationFull(
            redirect_uris=[AnyUrl("https://chat.example/callback")],
            token_endpoint_auth_method="none",
        )
        await provider.register_client(client)
        client = await provider.get_client(next(iter(provider.clients)))
        params = AuthorizationParams(
            state="state",
            scopes=[mcp_auth.MCP_READ_SCOPE],
            code_challenge="challenge",
            redirect_uri=AnyUrl("https://chat.example/callback"),
            redirect_uri_provided_explicitly=True,
        )
        consent_url = await provider.authorize(client, params)
        redirect = provider.approve(consent_url.rsplit("=", 1)[-1], user["id"])
        code = redirect.split("code=", 1)[1].split("&", 1)[0]
        authorization_code = await provider.load_authorization_code(client, code)
        token = await provider.exchange_authorization_code(client, authorization_code)
        assert token.access_token
        assert await provider.load_authorization_code(client, code) is None

    asyncio.run(scenario())


def test_docx_capability_url_is_signed_and_short_lived(monkeypatch):
    monkeypatch.setattr(mcp_server.settings, "session_secret", "test-secret")
    url = mcp_server.artifact_url("teacher-1", "plan-1")
    token = url.rsplit("/", 1)[-1]
    payload = mcp_artifacts._decode(token)
    assert payload == {"purpose": "mcp_artifact", "uid": "teacher-1", "pid": "plan-1", "exp": payload["exp"]}
