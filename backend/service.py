"""The generate -> validate -> stamp -> build -> persist pipeline.

Kept out of the route handlers so the same path is used by the streaming
endpoint, the non-streaming endpoint, the rewrite/rebuild endpoints, and the
eval harness — which is how they stay consistent.
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

from . import curriculum, db, docx_build, llm, retrieval, schema, schoolcal, storage, units
from .errors import AppError
from .retrieval import RetrievalResult
from .template_context import day_names_for_school

log = logging.getLogger("flexedacademy.service")


# The settings row can hold either form of the subject, and both must resolve or
# retrieval silently filters on a course that isn't in the store and grounds
# nothing:
#   * a course code ("AP_Lang") — what the Subject Framework dropdown now saves,
#     since its options come from /api/frameworks whose ids ARE the course codes
#   * a display name ("AP Language & Composition") — db.DEFAULT_SETTINGS, and any
#     row written before that dropdown was wired up
#
#   * a retired course code — an earlier CASE ingest wrote "English_Language_Arts",
#     "Mathematics" and "Writing", which no longer exist in the store. Josh's live
#     settings row held "English_Language_Arts", so without an alias the app would
#     have planned against AP Lang while the UI claimed ELA.
#
# Unknown values fall back to AP_Lang rather than raising: this app's reason to
# exist is that one course, and a stale settings row shouldn't take it down.
_SUBJECT_ALIASES = {
    # display names
    "AP Language & Composition": "AP_Lang",
    "English Language Arts": "ELA",
    "Mathematics": "Math",
    "Science": "Science",
    "Social Studies": "Social_Studies",
    "Arts Education": "Arts",
    "Digital Literacy & Computer Science": "DLCS",
    "Health Education": "Health",
    "Physical Education": "PE",
    "World Languages": "World_Languages",
    "Comprehensive School Counseling": "Counseling",
    # retired course codes
    "English_Language_Arts": "ELA",
    "Writing": "ELA",
}


def subject_code(subject: str) -> str:
    """Resolve whatever the settings row holds to a course code that exists."""
    from .routes.misc import SUBJECT_LABELS  # the course codes that actually exist

    subject = (subject or "").strip()
    if subject in SUBJECT_LABELS:
        return subject
    if subject in _SUBJECT_ALIASES:
        return _SUBJECT_ALIASES[subject]
    # Tolerate a full label ("Science (2023)").
    for code, label in SUBJECT_LABELS.items():
        if subject == label:
            return code
    # If not in hardcoded aliases, assume it is a valid dynamic subject (like AP Biology)
    return subject or "AP_Lang"


_subject_code = subject_code  # internal callers


def subject_label(subject: str) -> str:
    """Return the class subject as a human-readable document label.

    Classes store a stable framework id (for example ``Math`` or ``AP_Lang``),
    while the DOCX header should show the teacher-facing label. Adoption years
    belong in the picker, not in a lesson-plan header.
    """
    from .routes.misc import SUBJECT_LABELS

    raw = (subject or "").strip()
    label = SUBJECT_LABELS.get(subject_code(raw), raw.replace("_", " "))
    return label.split(" (", 1)[0].strip() or "English"


def with_subject(plan: dict, *, cls: dict | None = None, subject: str | None = None) -> dict:
    """Stamp the owning class's subject onto a plan before DOCX rendering.

    The fallback to the stored course keeps legacy plans renderable when the
    class was deleted or predates class-scoped identity fields.
    """
    out = dict(plan)
    source = (cls or {}).get("subject") or subject or out.get("subject") or out.get("course")
    if source:
        out["subject"] = subject_label(str(source))
    return out


def _resolve_subject_grade(user_id: str, cls: dict | None) -> tuple[str, int]:
    """(subject_code, grade) to retrieve and audit against — from the class's
    OWN subject/grade when given, else the account's most-recently-touched
    settings row.

    That fallback is the one _chat_class's own docstring (routes/generate.py)
    describes catching live: a teacher with more than one prep got whichever
    class's settings were touched most recently ANYWHERE in the account, not
    the one their current chat or plan is actually under. Shared here so
    prepare() and revise_day() — the two places that decide which standards
    a request is scoped to — can't drift into resolving that fallback two
    different ways. Omitting `cls` is only correct for the one case
    _chat_class itself returns None for: a legacy chat/plan with no
    class_id at all.
    """
    if cls:
        subject = cls.get("subject", "AP Language & Composition")
        grade_str = cls.get("grade", "11")
    else:
        s = db.get_settings_row(user_id)
        subject = s.get("subject", "AP Language & Composition")
        grade_str = s.get("grade", "11")

    try:
        grade = int(grade_str)
    except (ValueError, TypeError):
        grade = 11

    return _subject_code(subject), grade


def _resolve_state(cls: dict | None) -> str:
    """Which state's standards corpus to ground against — from the class's
    own `state` column, defaulting to 'AL' for a legacy class/plan with none
    set (every class before multi-state support existed). See
    _resolve_subject_grade just above for the same reasoning applied to
    subject/grade; kept as its own small helper since state, unlike
    subject/grade, has no account-level settings fallback to consult."""
    state = (cls or {}).get("state")
    return state.upper() if state else "AL"


def identity_for(user_id: str, cls: dict | None) -> dict:
    """teacher/course/period to stamp onto a plan.

    `course` comes straight from the class's own `name` when a class is
    known — that's the field ClassSwitcher lets the teacher pick, and the
    one this identity stamp must track. Reading it from the settings row
    instead (course=s["course"]) is the bug this function replaces: that
    row resolves to whichever class was most recently EDITED or CREATED
    (get_settings_row's `ORDER BY updated_at DESC`), not whichever class is
    currently selected — so switching classes with no edit left the header
    stamped with the old class's name while the plan body was already
    generated against the new one.

    teacher/period still come from `settings`, scoped to the class's own
    subject when known — those are account/subject-level, not something
    ClassSwitcher changes. Falls back to the account's most-recently-touched
    settings row only for legacy plans/chats with no class_id at all (same
    fallback `_resolve_subject_grade` documents).
    """
    if cls:
        s = db.get_settings_row(user_id, subject=cls["subject"])
        return {"teacher": s["teacher"], "course": cls["name"], "period": s["period"]}
    s = db.get_settings_row(user_id)
    return {"teacher": s["teacher"], "course": s["course"], "period": s["period"]}


def prepare(user_id: str, query: str, cls: dict | None = None) -> RetrievalResult:
    """Retrieve, and refuse to spend a token if the request can't be grounded.

    Two independent refusals, because they fail differently:
      * a named grade outside the corpus — semantically NEAR, so distance can't
        catch it, and answering would be confidently wrong (see retrieval.py)
      * nothing above the relevance floor — genuinely off-domain

    `cls`, when the caller has it, is the chat's own class — see
    _resolve_subject_grade's own docstring for why this matters and what
    omitting it means.
    """
    subject_code, grade = _resolve_subject_grade(user_id, cls)
    state = _resolve_state(cls)

    off_scope = retrieval.out_of_scope_grades(query, corpus_grade=grade)
    if off_scope:
        raise retrieval.scope_error(query, off_scope, corpus_grade=grade)

    # Rephrase into standards register before searching — a teacher's own wording
    # ("Week 6, voice and tone with The Cask of Amontillado") embeds badly against
    # abstract skill statements. See llm.expand_query.
    # Prepending the course and grade gives massive semantic context for the embeddings API.
    contextual_query = f"Course: {subject_code}, Grade: {grade} - {query}"

    result = retrieval.retrieve_grounded(
        contextual_query,
        subject_code=subject_code,
        grade=grade,
        extra_queries=llm.expand_query(user_id, contextual_query),
        state=state,
    )
    if result.empty:
        raise retrieval.no_grounded_standards_error(query, result)
    if result.only_act:
        raise retrieval.act_only_grounding_error(query, result, grade)
    return result


from fastapi import BackgroundTasks


def _build_docx_for_template(plan: dict, out_path: Path, school_id: str | None, template_id: str | None = None):
    """Keep legacy builder test doubles and old plans compatible."""
    plan = with_subject(plan)
    if template_id:
        return docx_build.build_docx(plan, out_path, school_id, template_id)
    return docx_build.build_docx(plan, out_path, school_id)


def _persist_docx(out_path: Path) -> None:
    """Refuse to mark a DOCX ready until its bytes are durable."""
    if not docx_build.is_valid_docx(out_path):
        raise AppError(
            "docx_invalid",
            "The builder did not produce a valid Word document.",
            hint="The lesson plan is saved; try rebuilding the document.",
        )
    if not storage.mirror_file(out_path):
        raise AppError(
            "docx_not_persisted",
            "The Word document was built but could not be saved safely.",
            status=503,
            hint="The plan is safe. Try the download again in a moment.",
        )


def _build_docx_bg(user_id: str, plan: dict, out_path: Path, plan_id: str):
    # FastAPI background work is not durable across a deploy or process restart.
    # Keep this compatibility entry point, but make it only enqueue work in the
    # Postgres-backed worker below.
    db.enqueue_document_build(plan_id, user_id)


def run_document_build_job(job: dict) -> None:
    """Build one claimed DOCX job; called by the durable server worker."""
    plan_id, user_id = job["plan_id"], job["user_id"]
    row = db.get_plan(user_id, plan_id)
    if not row or not row.get("plan_json"):
        db.finish_document_build(plan_id, user_id, error_message="The saved plan no longer exists.")
        return
    try:
        cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
        plan = with_subject(row["plan_json"], cls=cls)
        if plan != row["plan_json"]:
            db.update_plan(user_id, plan_id, plan_json=plan)
        out_path = docx_build.plan_output_path(plan, plan_id)
        _build_docx_for_template(plan, out_path, cls.get("school") if cls else None, row.get("template_id"))
        _persist_docx(out_path)
        db.update_plan(user_id, plan_id, docx_path=str(out_path))
        db.finish_document_build(plan_id, user_id)
        log.info("document build ready plan_id=%s", plan_id)
    except Exception as exc:
        log.exception("failed to build document plan_id=%s", plan_id)
        db.update_plan(user_id, plan_id, warnings=(row.get("warnings") or []) + [DOCX_FAILED])
        db.finish_document_build(plan_id, user_id, error_message=str(exc)[:500])


# Written into plans.warnings so the download endpoint can distinguish "not
# finished yet" from "will never finish".
DOCX_FAILED = "The document could not be built from this plan. Rebuild it to try again."


def repair_weeden_documents() -> int:
    """Replace the test school's Florence-shaped artifacts after deployment.

    The query is idempotent and only selects the erroneous stored template id.
    It runs from the deployed app so its output paths and durable-storage
    mirror are the same ones normal plan generation uses.
    """
    school_id = "weeden-elementary-school"
    repaired = 0
    for row in db.list_plans_for_school_template_repair(school_id, "florence-docx-v2"):
        plan = row.get("plan_json") or {}
        out_path = docx_build.plan_output_path(plan, row["id"])
        try:
            docx_build.build_docx(plan, out_path, school_id)
            _persist_docx(out_path)
            db.update_plan(
                row["user_id"], row["id"],
                docx_path=str(out_path),
                template=docx_build.builder_template(school_id),
            )
            repaired += 1
        except Exception:
            log.exception("failed to repair Weeden plan_id=%s", row["id"])
    if repaired:
        log.info("rebuilt %d Weeden document(s) with the district form", repaired)
    return repaired


def repair_weeden_missing_sections() -> int:
    """Backfill only blank, visible Weeden rows in plans saved before the guard.

    A document rebuild alone cannot invent pedagogically appropriate reteach
    and cross-curricular content.  This uses the same tightly scoped
    one-field revision path a teacher uses in the app, preserving every other
    part of the saved week byte-for-byte before rebuilding its DOCX.
    """
    school_id = "weeden-elementary-school"
    repaired = 0
    for row in db.list_plans_for_school(school_id):
        plan = row.get("plan_json") or {}
        days = plan.get("days") or []
        missing = [
            (index, field)
            for index, day in enumerate(days)
            if not day.get("no_school")
            for field in schema.WEEDEN_SECTION_FIELDS
            if not str(day.get(field) or "").strip()
        ]
        if not missing:
            continue

        updated = {**plan, "days": [dict(day) for day in days]}
        try:
            for index, field in missing:
                day = updated["days"][index]
                value = llm.rewrite_day_field(
                    row["user_id"],
                    day,
                    (
                        "This previously saved Weeden lesson plan left the "
                        f"required '{field}' row blank. Fill that one row with "
                        "concise, specific content tied to this day's existing lesson."
                    ),
                    field,
                    json.dumps(updated, indent=2),
                    RetrievalResult(),
                    class_id=row.get("class_id"),
                )
                if not str(value or "").strip():
                    raise ValueError(f"model returned blank {field!r} for day {index}")
                day[field] = value

            # The migration only writes a fully repaired plan; one failed LLM
            # call leaves the original record untouched for the next startup.
            updated, _ = schema.validate_plan(updated, require_weeden_sections=True)
            out_path = docx_build.plan_output_path(updated, row["id"])
            _build_docx_for_template(updated, out_path, school_id, row.get("template_id"))
            _persist_docx(out_path)
            db.update_plan(
                row["user_id"], row["id"],
                plan_json=updated,
                docx_path=str(out_path),
                template=docx_build.builder_template(school_id),
            )
            repaired += 1
        except Exception:
            log.exception("failed to backfill Weeden plan_id=%s", row["id"])

    if repaired:
        log.info("backfilled required Weeden sections in %d plan(s)", repaired)
    return repaired


def repair_weeden_plans() -> None:
    """Run the two legacy Weeden repairs in order, never concurrently."""
    repair_weeden_documents()
    repair_weeden_missing_sections()


def finalize(
    *,
    user_id: str,
    plan_raw: dict,
    query: str,
    result: RetrievalResult,
    chat_id: str | None = None,
    bg_tasks: BackgroundTasks | None = None,
    class_id: str | None = None,
    cls: dict | None = None,
    week_number: int | None = None,
    school_id: str | None = None,
    subject: str | None = None,
    grade: str | None = None,
) -> dict:
    """Validate, stamp identity, build the .docx, persist. Returns the plan row.

    `week_number` is the week the teacher actually asked for, when the caller
    knows it. Without it the week is parsed back out of whatever label the model
    wrote, which is a guess — see migration 11.

    `school_id`, alongside `week_number`, is what lets `unit` below prefer the
    teacher's OWN uploaded curriculum map over units.unit_for_week()'s
    hardcoded AP-Lang-only 9-unit map — omitting either just means the rail's
    "Built from" can't say more than that generic fallback (or "Week N" for
    every other subject, which is what it fell back to for a Pre-AP Algebra 2
    plan even though that class had a real pacing guide on file).

    `subject` MUST be the class's real subject code (classes.subject, e.g.
    "AP_Lang" or "Pre-AP Algebra 2" — the same value uploadCurriculumMap sends
    and list_curriculum_progress does an EXACT match against), never
    plan["course"]/settings.course. That's the free-text display string a
    teacher can type anything into ("Pre-AP Algebra 2 · 11th"), and passing it
    here silently returns zero curriculum_progress rows for every class whose
    display name isn't exactly the subject code — the same "right mechanism,
    wrong field" bug retrieval.chunk_for_code had, just one call site over.
    Falls back to the account's most-recently-touched settings row only when
    the caller has no class context at all (same fallback audit_grounding's
    own subject_code already uses, two lines below).
    """
    started = time.monotonic()
    # Weeden's approved form has three additional required daily rows. Legacy
    # plans may still open and rebuild, but a newly generated Weeden plan must
    # never persist with those cells blank just because the structured schema
    # permits an empty string.
    resolved_school_id = school_id or (cls or {}).get("school")
    uses_weeden_template = resolved_school_id == "weeden-elementary-school"
    preferred_template = (
        db.get_preferred_school_template(user_id, resolved_school_id)
        if resolved_school_id and resolved_school_id != "generic"
        else None
    )
    selected_template_id = preferred_template.get("id") if preferred_template else None
    template_days = day_names_for_school(
        resolved_school_id, template_id=selected_template_id, user_id=user_id
    )
    plan, warnings = schema.validate_plan(
        plan_raw, require_weeden_sections=uses_weeden_template, day_names=template_days
    )

    identity = identity_for(user_id, cls)
    plan = schema.with_identity(
        plan, teacher=identity["teacher"], course=identity["course"], period=identity["period"]
    )

    subject_code = subject or _subject_code(
        cls["subject"] if cls else db.get_settings_row(user_id).get("subject", "")
    )
    # cited_standards() is the same extraction audit_grounding runs internally
    # — computed again here (cheap: in-memory regex over a week's worth of
    # text, no I/O) rather than having audit_grounding hand its structured
    # rows back, so this stays a pure list-of-strings function for its other
    # caller (revise_day) to keep using as before.
    cited = retrieval.cited_standards(plan, result.codes, subject_code=subject_code)
    warnings += retrieval.audit_grounding(plan, result.codes, subject_code=subject_code)

    unit = units.unit_for_week(plan["week_of"], subject=plan["course"])
    if week_number is not None and school_id:
        week_row = next(
            (w for w in schoolcal.school_weeks(school_id) if w["week"] == week_number), None
        )
        if week_row:
            map_unit = curriculum.unit_for_calendar_week(user_id, subject_code, week_row)
            if map_unit and map_unit.get("unit"):
                unit = map_unit["unit"]

    plan_id = db.new_id()
    plan = with_subject(plan, cls=cls, subject=subject_code)
    out_path = docx_build.plan_output_path(plan, plan_id)

    if bg_tasks is not None:
        bg_tasks.add_task(_build_docx_bg, user_id, plan, out_path, plan_id)
        docx_path_val = None
    else:
        _build_docx_for_template(plan, out_path, resolved_school_id, selected_template_id)
        _persist_docx(out_path)
        docx_path_val = str(out_path)

    if class_id is None:
        # Used to fall back to resolve_class(user_id)'s "whichever class
        # happens to sort first" — a guess, applied silently, that pinned
        # every plan from a class-less request to the SAME fixed class
        # regardless of what the teacher was actually working on. That
        # produced exactly the mixed-class Library a teacher would see: plans
        # from three different preps all filed under whichever class the
        # fallback picked. A save with no real class context is a caller bug
        # (routes/generate.py should always resolve one — see its own
        # class_id handling), not something to paper over with a guess here.
        raise AppError(
            "class_required",
            "This plan isn't linked to a class.",
            hint="Open it from within a specific class and try again.",
        )

    row = db.create_plan(
        plan_id=plan_id,
        user_id=user_id,
        course=plan["course"],
        week_label=plan["week_of"],
        unit=unit,
        query=query,
        plan_json=plan,
        docx_path=docx_path_val,
        retrieved_ids=sorted(result.codes),
        warnings=warnings,
        chat_id=chat_id,
        template=docx_build.builder_template(resolved_school_id, selected_template_id),
        template_id=selected_template_id,
        class_id=class_id,
        week_number=week_number,
    )
    if bg_tasks is not None:
        # Queue only after the plan row exists; the durable worker can now
        # survive this request ending, a deploy, or a process restart.
        db.enqueue_document_build(plan_id, user_id)
    db.replace_plan_standards(
        plan_id, user_id, class_id=row.get("class_id"), subject=subject_code, grade=grade, entries=cited
    )
    log.info(
        "plan built id=%s week=%r warnings=%d elapsed_ms=%d",
        plan_id,
        plan["week_of"],
        len(warnings),
        int((time.monotonic() - started) * 1000),
    )
    return row


def generate(
    user_id: str,
    query: str,
    chat_id: str | None = None,
    bg_tasks: BackgroundTasks | None = None,
    class_id: str | None = None,
    school_id: str | None = None,
    cls: dict | None = None,
    retrieval_query: str | None = None,
) -> dict:
    """`class_id`/`school_id`, when the caller has them, are the chat's own
    class and its resolved school (routes/generate.py's _chat_class +
    db.class_school) — not re-derived here, so this stays a plain pass-
    through rather than a second place that could resolve them differently.
    `class_id=None` reaches `finalize`, which now rejects it outright rather
    than guessing a class — callers here are expected to always resolve a
    real one first.
    `school_id=None` means the caller had no chat context at all — the
    account default (get_user_school) is the only honest answer left, same
    as db.class_school's own fallback for a class with none of its own.

    `cls` is that same class as a full row, not just its id — prepare()
    needs subject/grade off it to retrieve the right course's standards
    (see prepare's own docstring), and finalize()'s audit_grounding needs
    the same subject to check citations against the right corpus. Passing
    class_id AND cls looks redundant; it exists because finalize has only
    ever taken the id, and giving it the row instead everywhere else this
    function's called wasn't this fix's job."""
    # Supporting document/conversation context belongs in the model prompt,
    # but the standards lookup should use only the teacher's actual request.
    result = prepare(user_id, retrieval_query or query, cls=cls)
    return finalize(
        user_id=user_id,
        plan_raw=llm.generate_plan(
            user_id,
            query,
            result,
            school_id=school_id or db.get_user_school(user_id),
            class_id=class_id,
        ),
        query=query,
        result=result,
        chat_id=chat_id,
        bg_tasks=bg_tasks,
        class_id=class_id,
        cls=cls,
        subject=cls["subject"] if cls else None,
        grade=cls["grade"] if cls else None,
    )


def rebuild(user_id: str, plan_id: str, bg_tasks: BackgroundTasks | None = None) -> dict:
    """Re-emit the .docx from stored plan_json.

    Because the plan is in the database, a lost or deleted document is always
    recoverable — which is what makes the download endpoint's 404 actionable.
    """
    row = db.get_plan(user_id, plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)
    plan = row["plan_json"]
    if not plan:
        raise AppError("plan_json_missing", "This plan has no stored content to rebuild from.")

    # Re-sanitise, and WRITE IT BACK. Rebuild used to re-emit the stored JSON
    # verbatim, so a plan carrying an XML-illegal character — see schema._clean —
    # failed exactly the same way every time it was rebuilt. The download
    # endpoint tells the teacher "rebuild it", so rebuild has to be able to
    # actually fix something; otherwise that hint is a loop.
    cleaned = schema._clean(plan)
    if cleaned != plan:
        log.info("rebuild repaired XML-illegal characters in plan_id=%s", plan_id)
        plan = cleaned
        db.update_plan(user_id, plan_id, plan_json=plan)

    cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
    plan = with_subject(plan, cls=cls)
    if plan != row["plan_json"]:
        db.update_plan(user_id, plan_id, plan_json=plan)
    out_path = docx_build.plan_output_path(plan, plan_id)

    if bg_tasks is not None:
        # Clear the previous failure marker; this attempt gets to succeed on its
        # own merits rather than inheriting the last one's verdict.
        db.update_plan(
            user_id,
            plan_id,
            docx_path=None,
            warnings=[w for w in (row.get("warnings") or []) if w != DOCX_FAILED],
        )
        bg_tasks.add_task(_build_docx_bg, user_id, plan, out_path, plan_id)
        return db.get_plan(user_id, plan_id)  # type: ignore[return-value]
    else:
        _build_docx_for_template(plan, out_path, cls.get("school") if cls else None, row.get("template_id"))
        _persist_docx(out_path)
        return db.update_plan(
            user_id,
            plan_id,
            docx_path=str(out_path),
            warnings=[w for w in (row.get("warnings") or []) if w != DOCX_FAILED],
        )  # type: ignore[return-value]


def revise_day(
    user_id: str,
    plan_id: str,
    day_index: int,
    feedback: str,
    field: str | None = None,
    bg_tasks: BackgroundTasks | None = None,
) -> dict:
    """Rewrite one day, then REBUILD the document.

    The old flow updated React state only, so the already-built .docx went stale
    and the file the teacher downloaded no longer matched the plan on screen.

    `field` narrows the rewrite to a single cell — what in-cell tweaking sends.
    Without it this regenerates the whole day, which for "make the Do Now a
    quickwrite" also re-rolls that day's standards and engagement tags and
    silently re-decides the grounding audit. With it, exactly one key changes and
    every sibling is byte-identical by construction. `field: None` behaves
    exactly as it always has.
    """
    if field is not None and field not in schema.REVISABLE_FIELDS:
        # This string reaches a prompt as a schema key. It is never taken on trust.
        raise AppError(
            "bad_field",
            f"{field!r} is not a revisable field.",
            status=400,
            hint=f"Expected one of: {', '.join(schema.REVISABLE_FIELDS)}.",
        )

    row = db.get_plan(user_id, plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)

    plan = row["plan_json"]
    days = plan.get("days", [])
    if not 0 <= day_index < len(days):
        raise AppError(
            "day_out_of_range",
            f"Day index {day_index} is outside this plan's {len(days)} days.",
            status=400,
        )

    original = days[day_index]
    # The plan's OWN class, not get_settings_row(user_id)'s account-wide
    # default — same cross-class leak _resolve_subject_grade's docstring
    # describes, just reachable from a revision instead of a fresh
    # generation. A plan predating classes (no class_id) still falls back
    # to the account default, same as _resolve_subject_grade does for a
    # class-less chat.
    cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
    subject_code, grade = _resolve_subject_grade(user_id, cls)

    # A tweak scoped to a field that cannot carry a standard code — do_now,
    # during, learning_targets — has nothing to retrieve FOR. Re-retrieving
    # would widen the allowed-code set on behalf of text that holds no codes,
    # and re-running the audit would re-decide grounding the teacher never
    # touched. Skipping both is the entire point of the scope.
    needs_retrieval = field is None or field in schema.CODE_BEARING_FIELDS

    if needs_retrieval:
        # Re-retrieve against the feedback so a revision can cite a standard the
        # original week didn't need, while still being grounded.
        # Prepending context to align with vector chunks
        contextual_feedback = f"Course: {subject_code}, Grade: {grade} - {feedback} {original.get('learning_targets', '')}"
        result = retrieval.retrieve_grounded(
            contextual_feedback,
            subject_code=subject_code,
            grade=grade,
            state=_resolve_state(cls),
        )
        if result.empty:
            # A revision is allowed to proceed ungrounded — it inherits the week's
            # standards — but it must not invent new codes, and the audit will flag
            # it if it does.
            result = RetrievalResult(chunks=[], rejected=result.rejected, floor=result.floor)
    else:
        result = RetrievalResult()

    import json as _json

    if field is None:
        updated_raw = llm.rewrite_day(
            user_id, original, feedback, _json.dumps(plan, indent=2), result, class_id=row.get("class_id")
        )
        row_class = db.get_class(user_id, row.get("class_id")) if row.get("class_id") else None
        school_for_revision = (
            db.class_school(row_class, user_id)
            if hasattr(db, "class_school")
            else (row_class or {}).get("school")
        )
        template_days = day_names_for_school(school_for_revision, user_id=user_id)
        updated, warnings = schema.validate_day(
            updated_raw, path=f"days[{day_index}]", day_names=template_days
        )

        if updated["name"] != original.get("name"):
            # Don't let a revision silently move a day to a different weekday.
            updated["name"] = original["name"]
            warnings.append(
                f"The revision tried to rename the day; kept it as {original['name']}."
            )
    else:
        value = llm.rewrite_day_field(
            user_id, original, feedback, field, _json.dumps(plan, indent=2), result, class_id=row.get("class_id")
        )
        # Merge over ONE key. Every sibling comes through by identity, which is
        # what makes "editing Wednesday's Do Now leaves Wednesday's standards
        # alone" a property of the code rather than a hope about the prompt.
        merged = {**original, field: value}
        # Still validated: the merged day is what the .docx builder receives, and
        # a scoped rewrite can just as easily return a learning target that
        # doesn't start with "I can" or an off-list engagement strategy.
        row_class = db.get_class(user_id, row.get("class_id")) if row.get("class_id") else None
        school_for_revision = (
            db.class_school(row_class, user_id)
            if hasattr(db, "class_school")
            else (row_class or {}).get("school")
        )
        template_days = day_names_for_school(school_for_revision, user_id=user_id)
        updated, warnings = schema.validate_day(
            merged, path=f"days[{day_index}]", day_names=template_days
        )
        # validate_day normalizes (strips, collapses newlines), so re-assert the
        # promise on the fields the teacher did not touch.
        for key, was in original.items():
            if key != field and key in updated:
                updated[key] = was

    new_days = list(days)
    new_days[day_index] = updated
    new_plan = with_subject({**plan, "days": new_days}, cls=cls, subject=subject_code)

    allowed = set(row.get("retrieved_ids") or []) | result.codes
    if needs_retrieval:
        warnings += retrieval.audit_grounding(new_plan, allowed, subject_code=subject_code)

    # The WHOLE plan's citations, not just this day's — plan_standards is a
    # full snapshot (see db.replace_plan_standards), and computing it only
    # for the touched day would wipe out every other day's history on every
    # single-field tweak.
    cited = retrieval.cited_standards(new_plan, allowed, subject_code=subject_code)

    out_path = docx_build.plan_output_path(new_plan, plan_id)

    if bg_tasks is not None:
        bg_tasks.add_task(_build_docx_bg, user_id, new_plan, out_path, plan_id)
        docx_path_val = None
    else:
        _build_docx_for_template(new_plan, out_path, cls.get("school") if cls else None, row.get("template_id"))
        _persist_docx(out_path)
        docx_path_val = str(out_path)

    updated_row = db.update_plan(
        user_id,
        plan_id,
        plan_json=new_plan,
        docx_path=docx_path_val,
        warnings=(row.get("warnings") or []) + warnings,
    )
    db.replace_plan_standards(
        plan_id,
        user_id,
        class_id=row.get("class_id"),
        subject=subject_code,
        grade=str(grade),
        entries=cited,
    )
    return updated_row  # type: ignore[return-value]


def set_day_field(
    user_id: str,
    plan_id: str,
    day_index: int,
    field: str,
    value: str,
    bg_tasks: BackgroundTasks | None = None,
) -> dict:
    """Set one day's field to an exact value the teacher already chose — no
    LLM call at all.

    revise_day exists for "make this better, however the model sees fit."
    This is the other case: the teacher picked a specific standard, verbatim,
    off the list of what this week actually retrieved (LessonPlanTable's
    standard picker) and knows exactly what the cell should say. Routing
    that through revise_day's "rewrite this field: <feedback>" would ask a
    model to reproduce a string it was just handed — pure downside, since
    the one thing that could happen is it reword the code or the standard's
    own text on the way through, the exact paraphrase risk this app's whole
    grounding apparatus exists to prevent, self-inflicted for no reason.

    Only CODE_BEARING_FIELDS may be set this way — the picker only ever
    offers a real standard, and only those two cells display one.

    Same validate -> audit -> persist -> rebuild tail as revise_day's
    single-field path (lines above), just with retrieval and the LLM call
    removed: the value is already grounded by construction, since the
    picker's own options came from retrieved_ids.
    """
    if field not in schema.CODE_BEARING_FIELDS:
        raise AppError(
            "bad_field",
            f"{field!r} cannot be set directly.",
            status=400,
            hint=f"Expected one of: {', '.join(schema.CODE_BEARING_FIELDS)}.",
        )

    row = db.get_plan(user_id, plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)

    plan = row["plan_json"]
    days = plan.get("days", [])
    if not 0 <= day_index < len(days):
        raise AppError(
            "day_out_of_range",
            f"Day index {day_index} is outside this plan's {len(days)} days.",
            status=400,
        )

    original = days[day_index]
    cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
    subject_code, grade = _resolve_subject_grade(user_id, cls)

    merged = {**original, field: value}
    updated, warnings = schema.validate_day(merged, path=f"days[{day_index}]")
    for key, was in original.items():
        if key != field and key in updated:
            updated[key] = was

    new_days = list(days)
    new_days[day_index] = updated
    new_plan = with_subject({**plan, "days": new_days}, cls=cls, subject=subject_code)

    allowed = set(row.get("retrieved_ids") or [])
    warnings += retrieval.audit_grounding(new_plan, allowed, subject_code=subject_code)
    cited = retrieval.cited_standards(new_plan, allowed, subject_code=subject_code)

    out_path = docx_build.plan_output_path(new_plan, plan_id)

    if bg_tasks is not None:
        bg_tasks.add_task(_build_docx_bg, user_id, new_plan, out_path, plan_id)
        docx_path_val = None
    else:
        _build_docx_for_template(new_plan, out_path, cls.get("school") if cls else None, row.get("template_id"))
        _persist_docx(out_path)
        docx_path_val = str(out_path)

    updated_row = db.update_plan(
        user_id,
        plan_id,
        plan_json=new_plan,
        docx_path=docx_path_val,
        warnings=(row.get("warnings") or []) + warnings,
    )
    db.replace_plan_standards(
        plan_id,
        user_id,
        class_id=row.get("class_id"),
        subject=subject_code,
        grade=str(grade),
        entries=cited,
    )
    return updated_row  # type: ignore[return-value]


def edit_day_field(
    user_id: str,
    plan_id: str,
    day_index: int,
    field: str,
    content: str,
    bg_tasks: BackgroundTasks | None = None,
) -> dict:
    """Save a teacher's direct edit to one cell without calling the LLM.

    The in-cell editor is deliberately an exact text editor. AI rewrites belong
    to the global composer; sending a teacher's hand-edited sentence through a
    model would make a basic save unpredictable. The same day validation,
    grounding audit, and document rebuild used by AI revisions still apply.
    """
    if field not in schema.REVISABLE_FIELDS:
        raise AppError(
            "bad_field",
            f"{field!r} cannot be edited directly.",
            status=400,
            hint=f"Expected one of: {', '.join(schema.REVISABLE_FIELDS)}.",
        )

    text = str(content or "").strip()
    if not text:
        raise AppError("empty_content", "A cell cannot be saved empty.", status=400)

    row = db.get_plan(user_id, plan_id)
    if not row:
        raise AppError("plan_not_found", "Plan not found", status=404)

    plan = row["plan_json"]
    days = plan.get("days", [])
    if not 0 <= day_index < len(days):
        raise AppError(
            "day_out_of_range",
            f"Day index {day_index} is outside this plan's {len(days)} days.",
            status=400,
        )

    original = days[day_index]
    value: object = text
    if field == "engagement_strategy":
        # The visual editor uses one line per strategy; commas are accepted too
        # because they are natural when a teacher dictates a pair aloud.
        value = [part.strip() for part in re.split(r"[\n,]+", text) if part.strip()]

    cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
    subject_code, grade = _resolve_subject_grade(user_id, cls)
    row_class = cls
    school_for_revision = (
        db.class_school(row_class, user_id)
        if hasattr(db, "class_school")
        else (row_class or {}).get("school")
    )
    template_days = day_names_for_school(school_for_revision, user_id=user_id)

    merged = {**original, field: value}
    updated, warnings = schema.validate_day(
        merged, path=f"days[{day_index}]", day_names=template_days
    )
    for key, was in original.items():
        if key != field and key in updated:
            updated[key] = was

    new_days = list(days)
    new_days[day_index] = updated
    new_plan = with_subject({**plan, "days": new_days}, cls=cls, subject=subject_code)

    allowed = set(row.get("retrieved_ids") or [])
    warnings += retrieval.audit_grounding(new_plan, allowed, subject_code=subject_code)
    cited = retrieval.cited_standards(new_plan, allowed, subject_code=subject_code)

    out_path = docx_build.plan_output_path(new_plan, plan_id)
    if bg_tasks is not None:
        bg_tasks.add_task(_build_docx_bg, user_id, new_plan, out_path, plan_id)
        docx_path_val = None
    else:
        _build_docx_for_template(
            new_plan,
            out_path,
            cls.get("school") if cls else None,
            row.get("template_id"),
        )
        _persist_docx(out_path)
        docx_path_val = str(out_path)

    updated_row = db.update_plan(
        user_id,
        plan_id,
        plan_json=new_plan,
        docx_path=docx_path_val,
        warnings=(row.get("warnings") or []) + warnings,
    )
    db.replace_plan_standards(
        plan_id,
        user_id,
        class_id=row.get("class_id"),
        subject=subject_code,
        grade=str(grade),
        entries=cited,
    )
    return updated_row  # type: ignore[return-value]


def revise_days(
    user_id: str,
    plan_id: str,
    day_indices: list[int],
    feedback: str,
    field: str,
    bg_tasks: BackgroundTasks | None = None,
) -> dict:
    """The same one-field, one-key rewrite as revise_day's `field` path, applied
    to several days from a single instruction — the batch counterpart to
    tweaking one cell at a time. One docx rebuild and one grounding audit
    cover every touched day, rather than N of each for N cells.

    A day marked `no_school` has nothing to rewrite and is silently skipped
    rather than erroring the whole batch over one closed day.
    """
    if field not in schema.REVISABLE_FIELDS:
        raise AppError(
            "bad_field",
            f"{field!r} is not a revisable field.",
            status=400,
            hint=f"Expected one of: {', '.join(schema.REVISABLE_FIELDS)}.",
        )

    row = db.get_plan(user_id, plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)

    plan = row["plan_json"]
    days = plan.get("days", [])
    for idx in day_indices:
        if not 0 <= idx < len(days):
            raise AppError(
                "day_out_of_range",
                f"Day index {idx} is outside this plan's {len(days)} days.",
                status=400,
            )

    targets = [i for i in day_indices if not days[i].get("no_school")]
    if not targets:
        raise AppError(
            "no_revisable_days",
            "None of the selected days have this field to revise.",
            status=400,
        )

    cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
    subject_code, grade = _resolve_subject_grade(user_id, cls)
    needs_retrieval = field in schema.CODE_BEARING_FIELDS

    import json as _json

    new_days = list(days)
    warnings: list[str] = []
    retrieved_codes: set[str] = set()
    for idx in targets:
        original = days[idx]
        if needs_retrieval:
            contextual_feedback = (
                f"Course: {subject_code}, Grade: {grade} - {feedback} {original.get('learning_targets', '')}"
            )
            result = retrieval.retrieve_grounded(contextual_feedback, subject_code=subject_code, grade=grade, state=_resolve_state(cls))
            if result.empty:
                result = RetrievalResult(chunks=[], rejected=result.rejected, floor=result.floor)
        else:
            result = RetrievalResult()
        retrieved_codes |= result.codes

        value = llm.rewrite_day_field(
            user_id, original, feedback, field, _json.dumps(plan, indent=2), result, class_id=row.get("class_id")
        )
        merged = {**original, field: value}
        updated, day_warnings = schema.validate_day(merged, path=f"days[{idx}]")
        for key, was in original.items():
            if key != field and key in updated:
                updated[key] = was
        new_days[idx] = updated
        warnings += day_warnings

    new_plan = {**plan, "days": new_days}

    allowed = set(row.get("retrieved_ids") or []) | retrieved_codes
    if needs_retrieval:
        warnings += retrieval.audit_grounding(new_plan, allowed, subject_code=subject_code)
    cited = retrieval.cited_standards(new_plan, allowed, subject_code=subject_code)

    out_path = docx_build.plan_output_path(new_plan, plan_id)

    if bg_tasks is not None:
        bg_tasks.add_task(_build_docx_bg, user_id, new_plan, out_path, plan_id)
        docx_path_val = None
    else:
        _build_docx_for_template(new_plan, out_path, cls.get("school") if cls else None, row.get("template_id"))
        _persist_docx(out_path)
        docx_path_val = str(out_path)

    updated_row = db.update_plan(
        user_id,
        plan_id,
        plan_json=new_plan,
        docx_path=docx_path_val,
        warnings=(row.get("warnings") or []) + warnings,
    )
    db.replace_plan_standards(
        plan_id,
        user_id,
        class_id=row.get("class_id"),
        subject=subject_code,
        grade=str(grade),
        entries=cited,
    )
    return updated_row  # type: ignore[return-value]
