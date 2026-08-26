"""Turning a teacher-uploaded calendar (file or link) into schoolcal.py's own
week-dict shape, safely.

Three steps, each of which can reject the submission outright rather than let
a bad calendar reach the database:
  1. extract_calendar_text  — get plain text out of an upload or a URL
  2. llm.parse_calendar_weeks — one structured-output call into the week shape
  3. validate_calendar_sanity — rule-based checks an LLM parsing mistake would
     fail, before anything is ever saved as pending

Nothing here persists the original file. See the "Document safety" section of
this feature's plan: extraction happens once, in memory/a temp file that's
deleted immediately after, and only the parsed `weeks` JSON is ever stored —
there's no saved artifact for a hostile upload to ever be re-opened from.
"""
from __future__ import annotations

import ipaddress
import logging
import socket
from pathlib import Path
from urllib.parse import urlparse

import requests

from . import llm
from .config import settings
from .errors import AppError
from .routes.misc import _spool, read_text_from_path

log = logging.getLogger("flexedacademy.calendar_intake")

# Deliberately excludes macro-capable formats (.doc, .docm, .xlsm, ...) — see
# the plan's "Document safety" section. Extraction never executes anything in
# the file; these are the only formats read_text_from_path knows how to read
# as plain text.
SUPPORTED_EXTS = {".pdf", ".docx", ".txt", ".md"}

_FETCH_TIMEOUT_S = 10
_MAX_FETCH_BYTES = 2 * 1024 * 1024


def _sniff_ext(filename: str, head: bytes) -> str:
    """Trust the file's own magic bytes over the client-supplied extension —
    a mismatch (e.g. a renamed .exe wearing a .pdf name) is rejected outright."""
    if head.startswith(b"%PDF-"):
        return ".pdf"
    if head[:4] == b"PK\x03\x04":
        # .docx is a zip; distinguishing it from a plain .zip by magic bytes
        # alone isn't reliable, so a PK header only passes if the claimed
        # extension already said .docx.
        return ".docx" if filename.lower().endswith(".docx") else ""
    # No reliable magic bytes for plain text — fall back to the claimed
    # extension, restricted to the text set.
    ext = Path(filename).suffix.lower()
    return ext if ext in {".txt", ".md"} else ""


def _validate_upload_type(filename: str, path: Path) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise AppError(
            "unsupported_file_type",
            f"Can't read {ext or 'that file type'}.",
            status=400,
            hint=f"Supported: {', '.join(sorted(SUPPORTED_EXTS))}",
        )
    with open(path, "rb") as fh:
        head = fh.read(8)
    sniffed = _sniff_ext(filename, head)
    if sniffed != ext:
        raise AppError(
            "file_type_mismatch",
            "That file's contents don't match its extension.",
            status=400,
        )
    return ext


def _reject_private_host(url: str) -> None:
    """Block the classic SSRF targets before a single byte is fetched:
    non-https schemes, and any hostname that resolves to a private, loopback,
    or link-local address (cloud metadata endpoints live in this range)."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise AppError("invalid_url", "The link must be an https:// URL.", status=400)
    if not parsed.hostname:
        raise AppError("invalid_url", "That doesn't look like a valid URL.", status=400)
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as e:
        raise AppError("invalid_url", "Could not resolve that URL's host.", status=400) from e
    for info in infos:
        addr = info[4][0]
        ip = ipaddress.ip_address(addr)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise AppError(
                "invalid_url",
                "That URL points at a private or internal address, which isn't allowed.",
                status=400,
            )


def fetch_url_text(url: str) -> str:
    """Fetch exactly the one URL a teacher explicitly gave, once — never
    followed automatically and never re-fetched. Hardened against SSRF: https
    only, private/loopback/link-local IPs rejected after DNS resolution, no
    redirect following, a timeout, and a response size cap."""
    _reject_private_host(url)
    try:
        resp = requests.get(
            url,
            timeout=_FETCH_TIMEOUT_S,
            allow_redirects=False,
            stream=True,
            headers={"User-Agent": "FlexEdAcademy-CalendarIntake/1.0"},
        )
    except requests.RequestException as e:
        raise AppError("fetch_failed", "Could not reach that URL.", status=422) from e
    if 300 <= resp.status_code < 400:
        raise AppError(
            "redirect_not_followed",
            "That URL redirects elsewhere — paste the final, direct link instead.",
            status=422,
        )
    if resp.status_code != 200:
        raise AppError("fetch_failed", f"That URL returned {resp.status_code}.", status=422)

    chunks = []
    total = 0
    for chunk in resp.iter_content(chunk_size=1 << 16):
        total += len(chunk)
        if total > _MAX_FETCH_BYTES:
            raise AppError("fetch_too_large", "That page is larger than the 2MB limit.", status=413)
        chunks.append(chunk)
    body = b"".join(chunks)

    content_type = resp.headers.get("content-type", "")
    if "pdf" in content_type or url.lower().endswith(".pdf"):
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".pdf") as fh:
            fh.write(body)
            fh.flush()
            return read_text_from_path(Path(fh.name), ".pdf")
    # Anything else is treated as HTML/plain text; a crude tag strip is good
    # enough for a published calendar page, which is what parse_calendar_weeks
    # actually reads meaning out of, not the markup.
    import re

    text = body.decode("utf-8", errors="ignore")
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def extract_calendar_text(*, upload=None, url: str | None = None) -> str:
    """Exactly one of `upload` (a FastAPI UploadFile) or `url` must be given."""
    if bool(upload) == bool(url):
        raise AppError("bad_request", "Provide either a file or a link, not both or neither.", status=400)

    if url:
        if "docs.google.com/document/d/" in url:
            from .routes.misc import _download_google_doc_as_docx
            path = _download_google_doc_as_docx(url, settings.max_doc_bytes)
            if not path:
                text = fetch_url_text(url)
            else:
                try:
                    text = read_text_from_path(path, ".docx")
                finally:
                    path.unlink(missing_ok=True)
        else:
            text = fetch_url_text(url)
    else:
        filename = upload.filename or "calendar"
        ext_hint = Path(filename).suffix.lower() or ".pdf"
        path = _spool(upload, ext_hint, settings.max_doc_bytes)
        try:
            ext = _validate_upload_type(filename, path)
            text = read_text_from_path(path, ext)
        finally:
            path.unlink(missing_ok=True)

    if not text.strip():
        raise AppError("empty_document", "No text could be read from that.", status=422)
    return text


_MIN_WEEKS = 25
_MAX_WEEKS = 45


def validate_calendar_sanity(weeks: list[dict]) -> None:
    """Rule-based checks that catch an LLM parsing mistake before it's ever
    saved — no human needs to look at garbage first. Raises AppError with the
    specific problem; never silently drops or fixes a week."""
    if not weeks:
        raise AppError("empty_calendar", "No weeks could be parsed from that calendar.", status=422)
    if not (_MIN_WEEKS <= len(weeks) <= _MAX_WEEKS):
        raise AppError(
            "implausible_week_count",
            f"Parsed {len(weeks)} weeks, which isn't a plausible school year (expected {_MIN_WEEKS}-{_MAX_WEEKS}).",
            status=422,
        )
    seen_numbers = set()
    prev_start = None
    for w in weeks:
        n = w.get("week")
        if not isinstance(n, int) or n in seen_numbers:
            raise AppError("bad_week_numbers", f"Week number {n!r} is missing or duplicated.", status=422)
        seen_numbers.add(n)
        start = w.get("start")
        if start:
            if prev_start and start < prev_start:
                raise AppError(
                    "weeks_out_of_order", f"Week {n}'s start date is earlier than an earlier week's.", status=422
                )
            prev_start = start
    if sorted(seen_numbers) != list(range(1, len(weeks) + 1)):
        raise AppError("bad_week_numbers", "Week numbers aren't a clean sequence starting at 1.", status=422)


def parse_and_validate(user_id: str, text: str) -> list[dict]:
    weeks = llm.parse_calendar_weeks(user_id, text)
    validate_calendar_sanity(weeks)
    return weeks
