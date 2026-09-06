"""User-scoped bearer tokens for the FlexEd MCP connector.

The MCP server cannot rely on the browser's ``aplang_session`` cookie because
ChatGPT and Claude call it as remote clients. These tokens are signed,
short-lived capabilities that carry the FlexEd user id and current session
version. They are deliberately separate from browser cookies, but revocation
still follows the same account-level ``session_version`` check.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from . import db
from .config import settings

MCP_READ_SCOPE = "flexed.read"
MCP_WRITE_SCOPE = "flexed.write"
MCP_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE]


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(payload_b64: str) -> str:
    return hmac.new(
        settings.session_secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()


def create_mcp_access_token(user_id: str, *, client_id: str = "flexed-mcp") -> dict[str, Any]:
    """Create a token for a logged-in FlexEd account."""
    user = db.get_user_by_id(user_id)
    if not user:
        raise ValueError("Unknown FlexEd user.")
    expires_at = int(time.time()) + max(300, int(settings.mcp_token_ttl_seconds))
    payload = {
        "purpose": "mcp_access",
        "uid": user_id,
        "sv": int(user.get("session_version", 0)),
        "client_id": client_id,
        "scopes": MCP_SCOPES,
        "exp": expires_at,
    }
    payload_b64 = _encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return {"access_token": f"flexed_{payload_b64}.{_sign(payload_b64)}", "expires_at": expires_at}


def decode_mcp_access_token(token: str) -> dict[str, Any] | None:
    if not token.startswith("flexed_"):
        return None
    token = token.removeprefix("flexed_")
    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(signature, _sign(payload_b64)):
        return None
    try:
        payload = json.loads(_decode(payload_b64))
    except (ValueError, TypeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("purpose") != "mcp_access":
        return None
    if not payload.get("uid") or int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def _account_is_valid(payload: dict[str, Any]) -> bool:
    user = db.get_user_by_id(str(payload["uid"]))
    if not user or user.get("is_blocked"):
        return False
    return int(user.get("session_version", 0)) == int(payload.get("sv", 0))


class FlexEdOAuthProvider(OAuthAuthorizationServerProvider[AuthorizationCode, RefreshToken, AccessToken]):
    """Small OAuth provider backed by signed FlexEd accounts.

    Client registrations and short-lived grants are process-local in this first
    release. The actual user authority remains FlexEd's database session: every
    access-token validation re-checks the account and session version. A later
    multi-instance deployment can move these short-lived records into Postgres
    without changing the MCP tools or OAuth contract.
    """

    def __init__(self) -> None:
        self.clients: dict[str, OAuthClientInformationFull] = {}
        self.pending: dict[str, tuple[OAuthClientInformationFull, AuthorizationParams]] = {}
        self.codes: dict[str, AuthorizationCode] = {}
        self.refresh_tokens: dict[str, RefreshToken] = {}
        self.refresh_versions: dict[str, int] = {}
        self.access_tokens: dict[str, AccessToken] = {}

    def connected_user(self, user_id: str) -> bool:
        """Return whether this worker has an active OAuth grant for a user."""
        now = int(time.time())
        for token in (*self.access_tokens.values(), *self.refresh_tokens.values()):
            if token.subject != user_id or (token.expires_at and token.expires_at < now):
                continue
            if _account_is_valid({"uid": user_id, "sv": self._session_version(user_id)}):
                return True
        return False

    def _session_version(self, user_id: str) -> int:
        user = db.get_user_by_id(user_id)
        return int(user.get("session_version", 0)) if user else -1

    def revoke_user(self, user_id: str) -> None:
        """Revoke all in-memory OAuth grants belonging to a FlexEd account."""
        access_tokens = [token for token, row in self.access_tokens.items() if row.subject == user_id]
        refresh_tokens = [token for token, row in self.refresh_tokens.items() if row.subject == user_id]
        for token in access_tokens:
            self.access_tokens.pop(token, None)
        for token in refresh_tokens:
            self.refresh_tokens.pop(token, None)
            self.refresh_versions.pop(token, None)

    def _base_url(self) -> str:
        return settings.mcp_public_url.rstrip("/") or f"http://localhost:{settings.api_port}"

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        return self.clients.get(client_id)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if not client_info.redirect_uris:
            raise ValueError("At least one redirect URI is required.")
        client_id = f"flexed_client_{secrets.token_urlsafe(24)}"
        client_secret = None
        if client_info.token_endpoint_auth_method not in (None, "none"):
            client_secret = secrets.token_urlsafe(32)
        registered = client_info.model_copy(
            update={
                "client_id": client_id,
                "client_secret": client_secret,
                "client_id_issued_at": int(time.time()),
            }
        )
        self.clients[client_id] = registered

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        request_id = secrets.token_urlsafe(32)
        self.pending[request_id] = (client, params)
        return f"{self._base_url()}/mcp/consent?request_id={request_id}"

    def approve(self, request_id: str, user_id: str) -> str:
        pending = self.pending.pop(request_id, None)
        if not pending:
            raise ValueError("This authorization request has expired.")
        client, params = pending
        code_value = secrets.token_urlsafe(32)
        self.codes[code_value] = AuthorizationCode(
            code=code_value,
            scopes=params.scopes or MCP_SCOPES,
            expires_at=time.time() + 300,
            client_id=str(client.client_id),
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource,
            subject=user_id,
        )
        return construct_redirect_uri(str(params.redirect_uri), code=code_value, state=params.state)

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        code = self.codes.get(authorization_code)
        if not code or code.client_id != client.client_id or code.expires_at < time.time():
            return None
        return code

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        code = self.codes.pop(authorization_code.code, None)
        if not code or code.expires_at < time.time() or code.client_id != client.client_id:
            raise ValueError("The authorization code is invalid or expired.")
        return self._issue_tokens(client, code.subject, code.scopes)

    def _issue_tokens(
        self, client: OAuthClientInformationFull, user_id: str | None, scopes: list[str]
    ) -> OAuthToken:
        user = db.get_user_by_id(user_id) if user_id else None
        if not user:
            raise ValueError("The FlexEd account is unavailable.")
        now = int(time.time())
        access_value = secrets.token_urlsafe(32)
        refresh_value = secrets.token_urlsafe(32)
        self.access_tokens[access_value] = AccessToken(
            token=access_value,
            client_id=str(client.client_id),
            scopes=scopes,
            expires_at=now + 3600,
            subject=user_id,
            claims={"session_version": int(user.get("session_version", 0))},
        )
        self.refresh_tokens[refresh_value] = RefreshToken(
            token=refresh_value,
            client_id=str(client.client_id),
            scopes=scopes,
            expires_at=now + 90 * 24 * 60 * 60,
            subject=user_id,
        )
        self.refresh_versions[refresh_value] = int(user.get("session_version", 0))
        return OAuthToken(
            access_token=access_value,
            expires_in=3600,
            scope=" ".join(scopes),
            refresh_token=refresh_value,
        )

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        token = self.refresh_tokens.get(refresh_token)
        if not token or token.client_id != client.client_id:
            return None
        if token.expires_at and token.expires_at < int(time.time()):
            return None
        user = db.get_user_by_id(str(token.subject)) if token.subject else None
        if not user or user.get("is_blocked"):
            return None
        if int(user.get("session_version", 0)) != self.refresh_versions.get(refresh_token, 0):
            return None
        return token

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        current = self.refresh_tokens.pop(refresh_token.token, None)
        current_version = self.refresh_versions.pop(refresh_token.token, None)
        if not current or current.client_id != client.client_id:
            raise ValueError("The refresh token is invalid.")
        user = db.get_user_by_id(str(current.subject)) if current.subject else None
        if not user or user.get("is_blocked") or int(user.get("session_version", 0)) != current_version:
            raise ValueError("The FlexEd session has been revoked.")
        requested = scopes or current.scopes
        if not set(requested).issubset(set(current.scopes)):
            raise ValueError("The requested scope exceeds the original grant.")
        return self._issue_tokens(client, current.subject, requested)

    async def load_access_token(self, token: str) -> AccessToken | None:
        if settings.mcp_access_token and hmac.compare_digest(token, settings.mcp_access_token):
            user_id = settings.mcp_access_user_id.strip()
            if user_id and db.get_user_by_id(user_id):
                return AccessToken(token=token, client_id="flexed-bootstrap", scopes=MCP_SCOPES, subject=user_id)
        signed = decode_mcp_access_token(token)
        if signed and _account_is_valid(signed):
            return AccessToken(
                token=token,
                client_id=str(signed.get("client_id", "flexed-mcp")),
                scopes=[str(scope) for scope in signed.get("scopes", MCP_SCOPES)],
                expires_at=int(signed["exp"]),
                subject=str(signed["uid"]),
            )
        access = self.access_tokens.get(token)
        if not access or (access.expires_at and access.expires_at < int(time.time())):
            return None
        user = db.get_user_by_id(str(access.subject)) if access.subject else None
        if not user or user.get("is_blocked"):
            return None
        if int(user.get("session_version", 0)) != int((access.claims or {}).get("session_version", 0)):
            return None
        return access

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        self.access_tokens.pop(token.token, None)
        self.refresh_tokens.pop(token.token, None)
        self.refresh_versions.pop(token.token, None)
