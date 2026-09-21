"""Teacher-owned delivery, deterministic readiness checks, and version history."""
from __future__ import annotations

import json
import re
from typing import Any

from . import db, retrieval
from .errors import AppError

REVIEW_KEYS = frozenset({'alignment', 'materials', 'timing'})


def require_plan(user_id: str, plan_id: str) -> dict:
    plan = db.get_plan(user_id, plan_id)
    if not plan:
        raise AppError('plan_not_found', 'No such plan.', status=404)
    return plan


def readiness(plan: dict, period_minutes: int | None = None) -> list[dict]:
    """Surface concrete omissions; never equate structural checks with pedagogy."""
    checks = []
    for index, day in enumerate(plan.get('days') or []):
        if day.get('no_school'):
            continue
        issues = []
        for field, label in [('learning_targets', 'learning target'), ('during', 'activity sequence'), ('assessment', 'assessment')]:
            if not str(day.get(field) or '').strip():
                issues.append({'code': f'missing_{field}', 'message': f'Add a concrete {label}.'})
        if not str(day.get('standards') or '').strip():
            issues.append({'code': 'missing_standards', 'message': 'Review standards alignment; no standard is listed for this day.'})
        lesson_text = ' '.join(str(day.get(key) or '') for key in ('do_now', 'during', 'assessment'))
        if re.search(r'\b(TODO|TBD|insert here|placeholder)\b', lesson_text, re.IGNORECASE):
            issues.append({'code': 'placeholder', 'message': 'Replace unfinished placeholder text before teaching.'})
        minutes = sum(int(n) for n in re.findall(r'\b(\d{1,3})\s*(?:minutes?|mins?)\b', lesson_text, re.IGNORECASE))
        if period_minutes and minutes > period_minutes:
            issues.append({'code': 'timing', 'message': f'Explicit activity times total {minutes} minutes; your period is {period_minutes} minutes. Check for overlapping times.'})
        checks.append({'day_index': index, 'name': day.get('name') or f'Day {index + 1}', 'issues': issues,
                       'explicit_minutes': minutes or None})
    return checks


def get_workflow(user_id: str, plan_id: str) -> dict:
    row = require_plan(user_id, plan_id)
    cls = db.get_class(user_id, row['class_id']) if row.get('class_id') else None
    progress = db._rows('SELECT day_index, plan_revision, status, notes, review_checks, updated_at FROM lesson_delivery WHERE plan_id = ? AND user_id = ? ORDER BY day_index', (plan_id, user_id))
    revision = row.get('revision', 1)
    return {'plan_id': plan_id, 'revision': revision, 'days': [dict(item) | {'outdated': item['plan_revision'] != revision} for item in progress],
            'readiness': readiness(row['plan_json'], (cls or {}).get('period_minutes')),
            'warnings': row.get('warnings') or [], 'provenance': row.get('provenance') or {}}


def save_delivery(user_id: str, plan_id: str, day_index: int, *, revision: int, status: str, notes: str, review_checks: dict) -> dict:
    # A row lock makes version validation and delivery update one operation.
    with db.borrow() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT plan_json, revision FROM plans WHERE id = %s AND user_id = %s FOR UPDATE', (plan_id, user_id))
            row = cur.fetchone()
            if not row:
                raise AppError('plan_not_found', 'No such plan.', status=404)
            if row['revision'] != revision:
                raise AppError('plan_changed', 'This plan changed. Reload it before recording delivery.', status=409)
            plan = json.loads(row['plan_json']) if isinstance(row['plan_json'], str) else row['plan_json']
            if not 0 <= day_index < len(plan.get('days') or []):
                raise AppError('day_not_found', 'That day is not in this plan.', status=404)
            if plan['days'][day_index].get('no_school'):
                raise AppError('no_school', 'There is no lesson on this day.', status=422)
            cur.execute('''INSERT INTO lesson_delivery(plan_id,user_id,day_index,plan_revision,status,notes,review_checks)
                VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb)
                ON CONFLICT(plan_id,day_index) DO UPDATE SET plan_revision=EXCLUDED.plan_revision,
                status=EXCLUDED.status,notes=EXCLUDED.notes,review_checks=EXCLUDED.review_checks,updated_at=now()
                WHERE lesson_delivery.user_id=EXCLUDED.user_id
                RETURNING day_index, plan_revision, status, notes, review_checks, updated_at''',
                (plan_id, user_id, day_index, revision, status, notes, json.dumps(review_checks)))
            result = dict(cur.fetchone())
        conn.commit()
    return result | {'outdated': False}


def list_versions(user_id: str, plan_id: str) -> list[dict]:
    require_plan(user_id, plan_id)
    return db._rows('SELECT revision, saved_at, plan_json, provenance FROM plan_versions WHERE plan_id = ? AND user_id = ? ORDER BY revision DESC LIMIT 50', (plan_id, user_id))


def restore_version(user_id: str, plan_id: str, revision: int, expected_revision: int) -> dict:
    with db.transaction() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT revision FROM plans WHERE id=%s AND user_id=%s FOR UPDATE', (plan_id, user_id))
            current = cur.fetchone()
            if not current:
                raise AppError('plan_not_found', 'No such plan.', status=404)
            if current['revision'] != expected_revision:
                raise AppError('plan_changed', 'The plan changed while you reviewed its history. Reload before restoring.', status=409)
            cur.execute('SELECT * FROM plan_versions WHERE plan_id=%s AND user_id=%s AND revision=%s', (plan_id, user_id, revision))
            version = cur.fetchone()
            if not version:
                raise AppError('version_not_found', 'That version is unavailable.', status=404)
            content = version['plan_json']
            cur.execute('''UPDATE plans SET revision=revision+1, plan_json=%s, retrieved_ids=%s, warnings=%s, provenance=%s::jsonb,
                template_id=%s, template=%s, unit=%s, week_number=%s,
                week_label=%s, course=%s, docx_path=NULL WHERE id=%s AND user_id=%s''',
                (json.dumps(content), json.dumps(version['retrieved_ids']), json.dumps(version['warnings']),
                 json.dumps(version['provenance']), version['template_id'], version['template'], version['unit'], version['week_number'],
                 content.get('week_of', ''), content.get('course', ''), plan_id, user_id))
        restored = require_plan(user_id, plan_id)
        cls = db.get_class(user_id, restored['class_id']) if restored.get('class_id') else None
        subject = (cls or {}).get('subject') or restored.get('course') or ''
        db.replace_plan_standards(
            plan_id, user_id, class_id=restored.get('class_id'), subject=subject,
            grade=str((cls or {}).get('grade') or ''),
            entries=retrieval.cited_standards(content, set(version['retrieved_ids'] or []), subject_code=subject),
        )
        # Restore clears the old artifact. Queue its replacement in the same
        # transaction, so a successful Undo cannot leave downloads pending forever.
        db.enqueue_document_build(plan_id, user_id)
        return restored


def handoff_prompt(row: dict, delivery: list[dict]) -> str:
    recorded = {item['day_index']: item for item in delivery}
    remaining = []
    reflections = []
    for index, day in enumerate(row['plan_json'].get('days') or []):
        if day.get('no_school'):
            continue
        item = recorded.get(index) or {}
        state = item.get('status', 'planned')
        if item.get('plan_revision', row.get('revision', 1)) != row.get('revision', 1):
            state = 'planned'
        if state in ('planned', 'skipped'):
            remaining.append(f"{day.get('name', index + 1)}: {day.get('learning_targets') or day.get('during') or 'Review unfinished lesson'}")
        if item.get('notes'):
            reflections.append(f"{day.get('name', index + 1)}: {item['notes']}")
    parts = [f"Build the following week for {row.get('course', 'this class')}, continuing from {row.get('week_label', 'the previous week')}. Reuse the class context and selected format."]
    if remaining:
        parts += ['Lessons still planned or skipped (confirm priorities, then carry forward what fits):', *remaining]
    if reflections:
        parts += ['My teaching reflections:', *reflections]
    parts += ['Build on lessons already taught; do not treat a cited standard as proof of student mastery.']
    return '\n'.join(parts)[:7000]


def record_provenance(user_id: str, plan_id: str, result: Any, model: str, *, revision: int) -> None:
    """Freeze the supplied retrieval evidence without persisting teacher prompts."""
    chunks = getattr(result, 'chunks', None) or getattr(result, 'hits', None) or []
    evidence = []
    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        metadata = chunk.get('metadata') or {}
        evidence.append({'id': chunk.get('id'), 'text': chunk.get('document') or metadata.get('description'), 'metadata': metadata, 'distance': chunk.get('distance')})
    provenance = {'model': model, 'sources': evidence, 'recorded_at': db.now(), 'schema_version': 1}
    with db.borrow() as conn:
        with conn.cursor() as cur:
            # A later edit must never inherit evidence from an earlier model run.
            cur.execute('UPDATE plans SET provenance=%s::jsonb WHERE id=%s AND user_id=%s AND revision=%s', (json.dumps(provenance), plan_id, user_id, revision))
            cur.execute('UPDATE plan_versions SET provenance=%s::jsonb WHERE plan_id=%s AND user_id=%s AND revision=%s', (json.dumps(provenance), plan_id, user_id, revision))
        conn.commit()
