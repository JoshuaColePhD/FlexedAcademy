"""Turn a .docx or .pdf into page images, for the vision judge in
backend/builder/codegen.py to compare a generated render against the real
uploaded template.

pdf2image + poppler are already a dependency (template_intake._ocr_pdf_text
uses them to OCR scanned PDF uploads) — `pdf_to_images` here factors that same
call out for reuse. `.docx` -> image needs an intermediate .docx -> .pdf step
that nothing in this codebase does today; `docx_to_images` shells out to
LibreOffice headless (`soffice --convert-to pdf`), a new system dependency
(see Dockerfile) added specifically for this pipeline.
"""
from __future__ import annotations

import base64
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..errors import AppError

log = logging.getLogger("flexedacademy.builder.rasterize")

_DPI = 150  # enough detail for a vision model to read cell text; not print quality
_MAX_PAGES = 3  # a weekly plan template is 1 page; bound cost on anything unusual
_SOFFICE_TIMEOUT_S = 60


def _soffice_available() -> bool:
    return shutil.which("soffice") is not None


def pdf_to_images(path: Path) -> list[object]:
    """list[PIL.Image.Image] for up to _MAX_PAGES pages. Raises on failure —
    same "never lie about succeeding" contract as template_intake._ocr_pdf_text."""
    import pdf2image

    return pdf2image.convert_from_path(str(path), dpi=_DPI, first_page=1, last_page=_MAX_PAGES)


def docx_to_images(path: Path) -> list[object]:
    """Convert a .docx to PDF via LibreOffice headless, then rasterize. Raises
    AppError if LibreOffice isn't installed (a clear, actionable error rather
    than a vision-judge call silently comparing against nothing) or if the
    conversion subprocess fails or times out."""
    if not _soffice_available():
        raise AppError(
            "soffice_missing",
            "LibreOffice headless (soffice) is not installed — required to render a .docx for visual verification.",
            hint="Install libreoffice in this environment (see Dockerfile).",
        )
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        try:
            subprocess.run(
                ["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(tmp_path), str(path)],
                check=True, capture_output=True, timeout=_SOFFICE_TIMEOUT_S,
            )
        except subprocess.CalledProcessError as e:
            raise AppError(
                "docx_rasterize_failed",
                f"LibreOffice could not convert {path.name} to PDF: {e.stderr.decode(errors='replace')[:500]}",
            ) from e
        except subprocess.TimeoutExpired as e:
            raise AppError(
                "docx_rasterize_timeout",
                f"LibreOffice conversion of {path.name} timed out after {_SOFFICE_TIMEOUT_S}s.",
            ) from e

        pdf_path = tmp_path / f"{path.stem}.pdf"
        if not pdf_path.is_file():
            raise AppError("docx_rasterize_failed", f"LibreOffice ran but produced no PDF for {path.name}.")
        return pdf_to_images(pdf_path)


def images_to_b64_png(images: list) -> list[str]:
    """PIL images -> base64-encoded PNG strings, ready for an OpenAI
    image_url content part (data:image/png;base64,...)."""
    import io

    out = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out.append(base64.b64encode(buf.getvalue()).decode("ascii"))
    return out


def file_to_b64_png(path: Path) -> list[str]:
    """Rasterize a .docx or .pdf (dispatched by extension) straight to
    base64 PNGs — the one call site backend/builder/codegen.py actually needs."""
    if path.suffix.lower() == ".pdf":
        images = pdf_to_images(path)
    elif path.suffix.lower() == ".docx":
        images = docx_to_images(path)
    else:
        raise AppError("unsupported_rasterize_type", f"Cannot rasterize a {path.suffix} file.")
    return images_to_b64_png(images)
