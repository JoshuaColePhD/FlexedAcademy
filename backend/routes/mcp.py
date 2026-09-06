"""HTTP endpoints that support the remote FlexEd MCP connector."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import settings
from ..deps import get_current_user
from ..errors import AppError
from ..mcp_auth import create_mcp_access_token
from ..mcp_server import oauth_provider

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


@router.post("/token")
def mint_token(user_id: str = Depends(get_current_user)) -> dict:
    """Mint a token to paste into a private MCP client during setup."""
    if not settings.mcp_enabled:
        raise AppError("mcp_disabled", "The FlexEd MCP connector is disabled.", status=404)
    token = create_mcp_access_token(user_id)
    base_url = settings.mcp_public_url.rstrip("/") or f"http://localhost:{settings.api_port}"
    return {**token, "server_url": f"{base_url}/mcp/"}


@router.get("/status")
def mcp_status(user_id: str = Depends(get_current_user)) -> dict:
    """Return the connection details needed by the FlexEd Integrations page."""
    if not settings.mcp_enabled:
        return {"enabled": False, "connected": False}
    base_url = settings.mcp_public_url.rstrip("/") or f"http://localhost:{settings.api_port}"
    return {
        "enabled": True,
        "connected": oauth_provider.connected_user(user_id),
        "server_url": f"{base_url}/mcp/",
        "oauth_metadata_url": f"{base_url}/mcp/.well-known/oauth-authorization-server",
    }


@router.post("/disconnect")
def disconnect_mcp(user_id: str = Depends(get_current_user)) -> dict:
    """Revoke the active MCP grants for the signed-in FlexEd account."""
    if not settings.mcp_enabled:
        raise AppError("mcp_disabled", "The FlexEd MCP connector is disabled.", status=404)
    oauth_provider.revoke_user(user_id)
    return {"connected": False}
