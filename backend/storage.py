"""Durable-file adapter with a local development fallback."""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from urllib.parse import quote

import requests

from .config import PROJECT_ROOT, settings

log = logging.getLogger("flexedacademy.storage")


def configured() -> bool:
    return bool(settings.supabase_url and settings.supabase_service_role_key)


def _key(path: Path) -> str:
    try:
        relative = path.resolve().relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        relative = Path(path.name)
    return str(relative).replace("\\", "/")


def _url(path: Path) -> str:
    return (
        f"{settings.supabase_url.rstrip('/')}/storage/v1/object/"
        f"{quote(settings.storage_bucket, safe='')}/{quote(_key(path), safe='/')}"
    )


def _headers() -> dict[str, str]:
    token = settings.supabase_service_role_key
    return {"Authorization": f"Bearer {token}", "apikey": token}


def mirror_file(path: Path) -> None:
    """Best-effort upload; local persistence remains the immediate fallback."""
    if not configured() or not path.is_file():
        return
    try:
        response = requests.post(
            _url(path),
            headers={
                **_headers(),
                "x-upsert": "true",
                "Content-Type": "application/octet-stream",
            },
            data=path.read_bytes(),
            timeout=30,
        )
        response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not mirror %s to durable storage: %s", _key(path), exc)


def ensure_local(path: Path) -> bool:
    """Restore a missing local file from durable storage when available."""
    if path.is_file():
        return True
    if not configured():
        return False
    try:
        response = requests.get(_url(path), headers=_headers(), timeout=30)
        if response.status_code == 404:
            return False
        response.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temp = Path(handle.name)
            handle.write(response.content)
        temp.replace(path)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("could not restore %s from durable storage: %s", _key(path), exc)
        return False


def remove_file(path: Path) -> None:
    path.unlink(missing_ok=True)
    if not configured():
        return
    try:
        response = requests.delete(_url(path), headers=_headers(), timeout=30)
        if response.status_code not in (204, 404):
            response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not remove %s from durable storage: %s", _key(path), exc)
