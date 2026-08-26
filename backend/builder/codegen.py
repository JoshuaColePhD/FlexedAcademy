"""The builder-codegen attempt loop: generate a declarative layout spec,
render it against a synthetic fixture, verify it visually against the real
uploaded template, retry with feedback up to a hard cap, and land the result
in the existing admin review queue either way.

Nothing here ever sets `schools.builder_status = 'verified'` — that is an
explicit admin action (db.approve_builder_codegen_job / the
POST /admin/builder-codegen/{job_id}/approve route), even when every attempt
in a job passes both vision judges within the attempt cap. The reason is the
vision judge is a brand-new, unproven trust boundary in this codebase (no
production track record, unlike the two-independent-LLM-pass pattern
template_intake.py's analysis pipeline has actually been running) — this can
be revisited once enough approved/rejected jobs establish the judge's
real-world precision. See the plan this was built from
(moonlit-wondering-spark.md) for the full rationale.

Entry point: run_codegen_job(job_id), called by the worker loop
(backend/server.py's startup hook polling db.claim_next_builder_codegen_job).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .. import db, llm
from ..config import settings
from . import rasterize
from .fixtures import fixture_expectations, synthetic_week_fixture
from .generic_renderer import SpecRenderError, render as render_spec
from .spec_validate import validate_spec_against_analysis

log = logging.getLogger("aplang.builder.codegen")

_ATTEMPT_ARTIFACT_DIR = Path("uploads/builder_codegen")


def _judge_verdict_passed(verdict: dict) -> bool:
    return bool(verdict.get("pass")) and isinstance(verdict.get("confidence"), (int, float)) and verdict["confidence"] >= 0.7


def _run_one_attempt(
    *,
    job: dict,
    attempt_number: int,
    user_id: str,
    structure_summary: str,
    analysis: dict,
    original_images_b64: list[str],
    fixture: dict,
    expectations: list[str],
    prior_feedback: str | None,
) -> tuple[bool, dict]:
    """Returns (passed, attempt_row). Never raises — any failure at any step
    becomes a failed, persisted attempt with an explanatory feedback string
    for the next attempt's prompt, same "turn a crash into a finding, not a
    500" contract template_intake.py's own stages already follow."""
    spec = llm.generate_layout_spec(
        user_id, structure_summary, analysis.get("sections") or [], prior_feedback=prior_feedback
    )

    validation_findings = validate_spec_against_analysis(spec, analysis)
    if validation_findings:
        feedback = "The spec was rejected before rendering: " + "; ".join(validation_findings)
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=None, judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}

    artifact_dir = _ATTEMPT_ARTIFACT_DIR / job["id"]
    artifact_dir.mkdir(parents=True, exist_ok=True)
    sample_docx = artifact_dir / f"attempt_{attempt_number}.docx"

    try:
        render_spec(spec, fixture, str(sample_docx))
    except SpecRenderError as e:
        feedback = f"The spec failed to render: {e}"
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=None, judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}
    except Exception as e:  # noqa: BLE001 — any renderer crash is a finding, not a job-ending exception
        feedback = f"The spec caused an unexpected rendering error: {e}"
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=None, judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}

    try:
        generated_images_b64 = rasterize.docx_to_images(sample_docx)
        generated_images_b64 = rasterize.images_to_b64_png(generated_images_b64)
    except Exception as e:  # noqa: BLE001
        feedback = f"The rendered sample could not be rasterized for review: {e}"
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=str(sample_docx), judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}

    judge1 = llm.judge_builder_render(
        user_id, original_images_b64=original_images_b64, generated_images_b64=generated_images_b64,
        layout_spec=spec, fixture_expectations=expectations,
    )
    judge2 = llm.judge_builder_render(
        user_id, original_images_b64=original_images_b64, generated_images_b64=generated_images_b64,
        layout_spec=spec, fixture_expectations=expectations,
    )
    passed = _judge_verdict_passed(judge1) and _judge_verdict_passed(judge2)

    attempt = db.record_builder_codegen_attempt(
        job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
        render_image_path=str(sample_docx), judge1_json=json.dumps(judge1), judge2_json=json.dumps(judge2),
        passed=passed,
    )
    if passed:
        return True, {**attempt, "_spec": spec}

    feedback = (
        f"Judge 1: pass={judge1.get('pass')}, defects={judge1.get('visual_defects')}, "
        f"field issues={[c for c in judge1.get('per_field_checks', []) if not c.get('correct_cell')]}, "
        f"reasoning: {judge1.get('reasoning')}\n"
        f"Judge 2: pass={judge2.get('pass')}, defects={judge2.get('visual_defects')}, "
        f"field issues={[c for c in judge2.get('per_field_checks', []) if not c.get('correct_cell')]}, "
        f"reasoning: {judge2.get('reasoning')}"
    )
    return False, {**attempt, "_feedback": feedback}


def run_codegen_job(job_id: str) -> None:
    """Runs one job to completion (succeeded or failed_needs_human) — the
    worker loop calls this once per claimed job, synchronously; a job is
    expected to take on the order of minutes (multiple LLM calls + LibreOffice
    renders), which is exactly why this lives behind a durable queue instead
    of a request handler or fire-and-forget BackgroundTasks."""
    job = db.get_builder_codegen_job(job_id)
    if not job:
        log.warning("run_codegen_job: job %s no longer exists", job_id)
        return

    template = db.get_school_template(job["template_id"])
    if not template or not template.get("structure_json") or not template.get("analysis_summary"):
        db.mark_builder_codegen_job_failed(job_id, "The template's analysis is missing or incomplete — cannot generate a spec from it.")
        return

    structure = json.loads(template["structure_json"])
    analysis = json.loads(template["analysis_summary"])

    from ..template_intake import _summarize_for_llm  # local import: avoid a hard import cycle at module load
    structure_summary = _summarize_for_llm(structure)

    original_path = Path(template["file_path"])
    try:
        original_images_b64 = rasterize.file_to_b64_png(original_path)
    except Exception as e:  # noqa: BLE001
        db.mark_builder_codegen_job_failed(job_id, f"Could not rasterize the original uploaded template for comparison: {e}")
        return

    fixture = synthetic_week_fixture(analysis)
    expectations = fixture_expectations(fixture)
    user_id = template.get("uploaded_by") or ""

    prior_feedback: str | None = None
    for attempt_number in range(1, settings.builder_codegen_max_attempts + 1):
        passed, attempt = _run_one_attempt(
            job=job, attempt_number=attempt_number, user_id=user_id,
            structure_summary=structure_summary, analysis=analysis,
            original_images_b64=original_images_b64, fixture=fixture, expectations=expectations,
            prior_feedback=prior_feedback,
        )
        if passed:
            db.mark_builder_codegen_job_succeeded(job_id, json.dumps(attempt["_spec"]))
            log.info("builder codegen job %s succeeded on attempt %d", job_id, attempt_number)
            return
        prior_feedback = attempt.get("_feedback")
        log.info("builder codegen job %s attempt %d failed: %s", job_id, attempt_number, prior_feedback)

    db.mark_builder_codegen_job_failed(
        job_id,
        f"No attempt passed both vision judges within {settings.builder_codegen_max_attempts} attempts. "
        "See builder_codegen_attempts for the full history.",
    )
