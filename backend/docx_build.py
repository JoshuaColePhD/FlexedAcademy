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
from types import ModuleType, SimpleNamespace

from .config import settings
from .errors import AppError
from .schema import ENGAGEMENT_OPTIONS

log = logging.getLogger("flexedacademy.docx")


def _generated_spec_builder(school_id: str, layout_spec: dict) -> SimpleNamespace:
    """A module-shaped wrapper (matches the same build(data, out_path)
    contract assert_builder_contract() checks) around a school's verified,
    automated-codegen layout spec, rendered through the one shared
    backend.builder.generic_renderer — never a school-specific generated
    Python file. See backend/builder/codegen.py for how a spec earns
    'verified' status: either an explicit admin approval, or (as of the
    loosened auto-verify bar) automatically, the moment the spec passes
    both vision judges on its own — usable here even while the school's
    separate template_status review is still pending."""
    from .builder.generic_renderer import render as _render

    def build(data: dict, out_path: str) -> None:
        _render(layout_spec, data, out_path)

    return SimpleNamespace(build=build, __doc__=f"Generated builder spec for {school_id} (template unknown)")


def _custom_builder_school_ids() -> set[str]:
    """Every school_id with a hand-written {school_id}_builder.py file,
    from one directory listing rather than a file-existence check per
    school — GET /api/schools lists ~1,600 rows, and its own docstring
    already flags avoiding exactly this N+1 shape (see
    schoolcal.bulk_calendar_status)."""
    path = Path(settings.builder_path)
    suffix = "_builder.py"
    return {p.name[: -len(suffix)] for p in path.parent.glob(f"*{suffix}")}


def bulk_builder_readiness(school_rows: list[dict]) -> dict[str, str]:
    """{school_id: "ready" | "ready_unverified" | "in_progress" | "pending"
    | "blocked"} for a batch of already-fetched school rows — the signal
    frontend/ChatPage.jsx's TemplateBanner uses to know whether downloads
    for this school will use its real template, its real template but not
    yet content-reviewed ('ready_unverified' — see below), a codegen job is
    actively drafting one right now ('in_progress' — see below), silently
    fall back to the generic one (still 'pending', no job has ever run or
    produced anything usable), or are currently BROKEN: `template_status`
    reached 'active' (analysis auto-activation, which only ever judges
    analysis quality) before a real builder — hand-written, or
    codegen-generated — exists for it. `docx_build.builder()` raises
    exactly in that last case; this is what lets the UI say so before a
    teacher hits it as a failed download.

    template_status and builder_status are deliberately separate columns
    (migration 52) — this function is where the two get reconciled into the
    one fact a teacher-facing banner actually needs.

    'ready_unverified': a usable builder exists (hand-written, or
    codegen-generated and either admin-approved or auto-verified — see
    codegen.py's loosened _meets_auto_verify_bar) but template_status
    hasn't reached 'active' yet — the school's own layout is already being
    used for real generation, the separate content review just hasn't
    caught up. Reported distinctly from 'ready' so the UI keeps saying that
    review is still in flight, rather than silently going quiet about it
    the moment generation itself starts working.

    'in_progress': no usable builder YET, but db.builder_codegen_jobs has a
    'queued' or 'running' row for this school — a teacher who just uploaded
    a template used to see the exact same flat 'pending' the whole time,
    with nothing distinguishing "nobody's looked at this yet" from "the AI
    is actively drafting your format right now." Checked ahead of the
    plain 'pending'/'blocked' fallbacks, but never overrides an
    already-usable builder — a stray queued/running row (e.g. a re-upload
    kicking off a second job while the first result is still live) should
    never mask a working banner."""
    from . import db

    custom_ids = _custom_builder_school_ids()
    in_progress_ids = db.active_builder_codegen_school_ids()
    out: dict[str, str] = {}
    for s in school_rows:
        sid = s["id"]
        has_builder = sid in custom_ids or s.get("builder_status") == "verified"
        if sid == settings.default_builder_school_id:
            out[sid] = "ready"
        elif has_builder:
            out[sid] = "ready" if s.get("template_status") == "active" else "ready_unverified"
        elif sid in in_progress_ids:
            out[sid] = "in_progress"
        elif s.get("template_status") != "active":
            out[sid] = "pending"
        else:
            out[sid] = "blocked"
    return out


@lru_cache(maxsize=128)
def builder(school_id: str | None = None) -> ModuleType | SimpleNamespace:
    from . import db

    path = Path(settings.builder_path)

    if school_id and school_id != "generic" and school_id != settings.default_builder_school_id:
        school = db.get_school(school_id)
        # template_status == 'active' is the normal, fully-reviewed case.
        # builder_status == 'verified' is included on its own too — a job
        # can auto-verify (codegen.py's loosened _meets_auto_verify_bar) or
        # get an admin's explicit approve before the SEPARATE template
        # content review reaches 'active' — so a verified builder is usable
        # the moment it exists, not gated on that other review finishing.
        # bulk_builder_readiness reports this window as 'ready_unverified'
        # rather than 'ready' so the UI keeps saying so.
        if school and (school.get("template_status") == "active" or school.get("builder_status") == "verified"):
            # A custom builder lives at the same directory as the default one,
            # named {school_id}_builder.py. Falling through to the default
            # (Florence's own AP-Lang builder) when this file is missing used
            # to be silent — every school in `schools` that's 'active' but has
            # no builder script yet (the column DEFAULTs to 'active', so any
            # seeded row that doesn't set it explicitly qualifies) got
            # Florence's layout, ACT-alignment row and all, with nothing
            # anywhere saying so. A school marked active is a promise that
            # generation is ready for real teachers there; a missing builder
            # means that promise wasn't kept, and that has to be loud.
            custom_path = path.parent / f"{school_id}_builder.py"
            if custom_path.is_file():
                path = custom_path
            elif school.get("builder_status") == "verified":
                # No hand-written file, but a generated layout spec for this
                # school has been verified — either an admin explicitly
                # approved it (db.approve_builder_codegen_job), or it
                # auto-verified on its own after passing both vision judges
                # (db.mark_builder_codegen_job_auto_verified, see
                # backend/builder/codegen.py). A hand-written file still
                # wins if one exists, so replacing a generated spec later
                # with a real hand-written builder just works.
                layout_spec = db.get_school_builder_spec(school_id)
                if layout_spec:
                    return _generated_spec_builder(school_id, layout_spec)
                raise AppError(
                    "builder_missing_for_school",
                    f"{school.get('name', school_id)} is marked builder_status='verified', "
                    "but no layout spec could be loaded for it.",
                    hint="This should not happen — check builder_codegen_jobs for this school.",
                )
            else:
                raise AppError(
                    "builder_missing_for_school",
                    f"{school.get('name', school_id)} is marked as having an active "
                    "template, but no document builder exists for it yet.",
                    hint=(
                        "Its uploaded template was approved, but nothing has generated "
                        "a builder script for it — without this check, it would silently "
                        "render using Florence High School's layout instead."
                    ),
                )

    if not path.is_file():
        raise AppError(
            "builder_missing",
            "The canonical lesson-plan builder script was not found.",
            hint=f"Expected it at {path}. Set BUILDER_PATH if it moved.",
        )
    spec = importlib.util.spec_from_file_location(path.stem, str(path))
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


def build_docx(plan: dict, out_path: Path, school_id: str | None = None) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        builder(school_id).build(plan, str(out_path))
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
