"""Build the .docx by importing the canonical builder, not by shelling out.

Two reasons this is an import and not a subprocess:

  * `subprocess.run(..., check=True)` discarded the child's stderr, so a builder
    crash surfaced only as "Command '[...]' returned non-zero exit status 1"
    with no cause.
  * It removes the intermediate temp_<uuid>.json entirely — we pass the dict.

The builder lives OUTSIDE this repo (Iris_OS/Skills/build-lesson-plan/) and is
shared with the skill. Forking it is exactly how the app ended up emitting
v1-shaped documents while the district template had moved to v2, so instead of
copying it we import it and assert its contract at startup.
"""
from __future__ import annotations

import importlib.util
import logging
import re
from functools import lru_cache
from pathlib import Path
from types import ModuleType

from .config import settings
from .errors import AppError
from .schema import ENGAGEMENT_OPTIONS

log = logging.getLogger("aplang.docx")


@lru_cache(maxsize=1)
def builder() -> ModuleType:
    path = Path(settings.builder_path)
    if not path.is_file():
        raise AppError(
            "builder_missing",
            "The canonical lesson-plan builder script was not found.",
            hint=f"Expected it at {path}. Set BUILDER_PATH if it moved.",
        )
    spec = importlib.util.spec_from_file_location("fcs_builder", str(path))
    if spec is None or spec.loader is None:
        raise AppError("builder_unloadable", f"Could not load the builder at {path}.")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def builder_template() -> str:
    """Read the template id out of the builder's docstring, e.g. florence-docx-v2."""
    doc = builder().__doc__ or ""
    m = re.search(r"template\s+(florence-docx-v\d+)", doc)
    return m.group(1) if m else "unknown"


def assert_builder_contract() -> None:
    """Fail loudly at boot if the shared builder changed under us.

    This is the check that would have caught the original v1/v2 drift.
    """
    mod = builder()
    if not callable(getattr(mod, "build", None)):
        raise AppError("builder_contract", "The builder script has no build() function.")

    theirs = list(getattr(mod, "ENGAGEMENT_OPTIONS", []))
    if theirs and theirs != ENGAGEMENT_OPTIONS:
        raise AppError(
            "builder_contract",
            "ENGAGEMENT_OPTIONS in the canonical builder no longer matches backend/schema.py.",
            hint=(
                f"Builder has {theirs!r}. Update ENGAGEMENT_OPTIONS in backend/schema.py "
                "to match, or the Word dropdown will show off-list values."
            ),
        )

    tmpl = builder_template()
    if tmpl != "florence-docx-v2":
        log.warning(
            "builder template is %r, not florence-docx-v2 — verify the output "
            "still matches the district form",
            tmpl,
        )
    log.info("builder ok: %s (%s)", settings.builder_path, tmpl)


_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_filename(text: str, fallback: str = "Lesson_Plan") -> str:
    """'Week 11 — Oct 19-23, 2026' -> 'Week_11_Oct_19-23_2026'."""
    cleaned = _SAFE.sub("_", text.replace("—", "-")).strip("_")
    cleaned = re.sub(r"_+", "_", cleaned)
    return cleaned or fallback


def plan_output_path(plan: dict, plan_id: str) -> Path:
    """plans/<course-slug>/Week_11_Oct_19-23__<id8>.docx

    Mirrors the CLAUDE.md naming convention (Week_XX_Mon_DD-DD.docx) with a
    short id suffix, so regenerating a week doesn't clobber the earlier attempt.
    """
    course = safe_filename(str(plan.get("course") or "Course"), "Course")
    week = safe_filename(str(plan.get("week_of") or "Week"), "Week")
    return Path(settings.plans_dir) / course / f"{week}__{plan_id[:8]}.docx"


def build_docx(plan: dict, out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        builder().build(plan, str(out_path))
    except AppError:
        raise
    except Exception as e:  # the builder's own failure, with its real message
        raise AppError(
            "docx_build_failed",
            f"The district template builder failed: {e}",
            hint="This usually means a field the template needs was missing or the wrong type.",
        ) from e
    if not out_path.is_file():
        raise AppError("docx_not_created", "The builder ran but produced no file.")
    return out_path
