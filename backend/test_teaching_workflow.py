"""Behavioral checks for teacher review, version conflicts and durable uploads."""
from contextlib import contextmanager, nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import db, material_jobs, teaching
from backend.deps import get_current_user
from backend.errors import AppError, app_error_handler
from backend.routes import curriculum as materials_route
from backend.routes import teaching as teaching_route


def test_readiness_surfaces_omissions_and_timing_without_flagging_days_off():
    checks = teaching.readiness({'days': [
        {'name': 'Monday', 'no_school': True},
        {'name': 'Tuesday', 'learning_targets': '', 'standards': '', 'do_now': '10 minutes',
         'during': '35 mins discussion', 'assessment': 'TBD: 15 minutes'},
    ]}, period_minutes=50)
    assert len(checks) == 1
    assert checks[0]['day_index'] == 1
    assert checks[0]['explicit_minutes'] == 60
    assert {item['code'] for item in checks[0]['issues']} == {'missing_learning_targets', 'missing_standards', 'placeholder', 'timing'}


def test_handoff_carries_unfinished_work_and_notes_but_not_claims_of_mastery():
    row = {'revision': 3, 'course': 'English', 'week_label': 'Week 3', 'plan_json': {'days': [
        {'name': 'Monday', 'learning_targets': 'Identify claims'},
        {'name': 'Tuesday', 'learning_targets': 'Evaluate reasons'},
        {'name': 'Wednesday', 'learning_targets': 'Compare evidence'},
        {'name': 'Thursday', 'no_school': True},
    ]}}
    prompt = teaching.handoff_prompt(row, [
        {'day_index': 0, 'plan_revision': 3, 'status': 'taught', 'notes': 'Need a shorter opener'},
        {'day_index': 1, 'plan_revision': 2, 'status': 'taught'},
        {'day_index': 2, 'plan_revision': 3, 'status': 'skipped'},
    ])
    assert 'Identify claims' not in prompt
    assert 'Evaluate reasons' in prompt and 'Compare evidence' in prompt
    assert 'Need a shorter opener' in prompt
    assert 'Thursday' not in prompt
    assert 'do not treat a cited standard as proof of student mastery' in prompt


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(teaching_route.router)
    app.add_exception_handler(AppError, app_error_handler)
    app.dependency_overrides[get_current_user] = lambda: 'teacher-a'
    return TestClient(app)


@pytest.mark.parametrize('patch', [{'revision': 0}, {'status': 'mastered'}, {'notes': 'x' * 2001}, {'review_checks': {'invented': True}}])
def test_delivery_rejects_invalid_records_before_storage(client, monkeypatch, patch):
    save = MagicMock()
    monkeypatch.setattr(teaching, 'save_delivery', save)
    response = client.put('/api/teaching/plans/p1/days/0', json={'revision': 1, 'status': 'planned', **patch})
    assert response.status_code == 422
    save.assert_not_called()


def test_owned_plan_required_for_reading_history(client, monkeypatch):
    lookup = MagicMock(return_value=None)
    monkeypatch.setattr(db, 'get_plan', lookup)
    response = client.get('/api/teaching/plans/another-teachers-plan/versions')
    assert response.status_code == 404
    lookup.assert_called_once_with('teacher-a', 'another-teachers-plan')


def test_delivery_conflict_does_not_write(monkeypatch):
    cur = MagicMock()
    cur.__enter__.return_value = cur
    cur.fetchone.return_value = {'revision': 2, 'plan_json': {'days': [{}]}}
    conn = MagicMock()
    conn.cursor.return_value = cur
    monkeypatch.setattr(db, 'borrow', lambda: nullcontext(conn))
    with pytest.raises(AppError) as error:
        teaching.save_delivery('teacher-a', 'p1', 0, revision=1, status='taught', notes='', review_checks={})
    assert error.value.status == 409
    assert cur.execute.call_count == 1
    conn.commit.assert_not_called()


@pytest.mark.parametrize('current_revision', [2, 3])
def test_restore_queues_export_atomically_and_conflicts_queue_nothing(monkeypatch, current_revision):
    cur = MagicMock()
    cur.__enter__.return_value = cur
    version = {'plan_json': {'course': 'English', 'days': []}, 'retrieved_ids': [],
               'warnings': [], 'provenance': {}, 'template_id': None, 'template': 'default',
               'unit': '', 'week_number': 3}
    cur.fetchone.side_effect = [{'revision': current_revision}, version]
    conn = MagicMock()
    conn.cursor.return_value = cur
    in_transaction = False

    @contextmanager
    def transaction():
        nonlocal in_transaction
        in_transaction = True
        yield conn
        in_transaction = False

    monkeypatch.setattr(db, 'transaction', transaction)
    restored = {'id': 'p1', 'course': 'English', 'revision': 3, 'plan_json': version['plan_json'], 'docx_path': None}
    monkeypatch.setattr(teaching, 'require_plan', lambda *_: restored)
    monkeypatch.setattr(db, 'replace_plan_standards', MagicMock())
    monkeypatch.setattr(teaching.retrieval, 'cited_standards', lambda *_args, **_kwargs: [])

    def enqueue(*_):
        assert in_transaction, 'The export must commit atomically with the restored plan.'

    queue = MagicMock(side_effect=enqueue)
    monkeypatch.setattr(db, 'enqueue_document_build', queue)
    if current_revision == 3:
        with pytest.raises(AppError, match='plan changed'):
            teaching.restore_version('teacher-a', 'p1', 1, 2)
        queue.assert_not_called()
        assert cur.execute.call_count == 1
    else:
        assert teaching.restore_version('teacher-a', 'p1', 1, 2) == restored
        queue.assert_called_once_with('p1', 'teacher-a')


def test_provenance_updates_only_the_captured_revision(monkeypatch):
    cur = MagicMock()
    cur.__enter__.return_value = cur
    conn = MagicMock()
    conn.cursor.return_value = cur
    monkeypatch.setattr(db, 'borrow', lambda: nullcontext(conn))
    teaching.record_provenance('teacher-a', 'p1', SimpleNamespace(hits=[{'id': 'S1', 'document': 'Official text'}]), 'test-model', revision=4)
    assert cur.execute.call_count == 2
    for call in cur.execute.call_args_list:
        sql, args = call.args
        assert 'revision=%s' in sql
        assert args[-1] == 4
        assert 'Official text' in args[0]


def test_upload_preview_requires_ownership_before_reading_chunks(monkeypatch):
    monkeypatch.setattr(db, 'get_curriculum_map', lambda *_: None)
    rows = MagicMock()
    monkeypatch.setattr(db, '_rows', rows)
    with pytest.raises(AppError) as error:
        materials_route.preview_curriculum_map('private-map', 'teacher-a')
    assert error.value.status == 404
    rows.assert_not_called()


def test_material_terminal_entitlement_failure_preserves_original_and_stops_retry(monkeypatch, tmp_path):
    original = tmp_path / 'pacing.txt'
    original.write_text('Week 1: Claims and evidence')
    monkeypatch.setattr(db, 'as_user', lambda _: nullcontext())
    monkeypatch.setattr(material_jobs, 'maintain_lease', lambda _: nullcontext())
    monkeypatch.setattr(db, 'get_curriculum_map', lambda *_: {'stored_path': str(original), 'subject': 'English', 'kind': 'pacing_guide'})
    monkeypatch.setattr(db, '_write', MagicMock())
    monkeypatch.setattr(material_jobs, 'require_entitlement', MagicMock(side_effect=AppError('trial_expired', 'Trial ended', status=402)))
    embed = MagicMock()
    monkeypatch.setattr(material_jobs.curriculum, 'embed_map', embed)
    cur = MagicMock()
    cur.__enter__.return_value = cur
    cur.fetchone.return_value = {'map_id': 'm1'}
    conn = MagicMock()
    conn.cursor.return_value = cur
    monkeypatch.setattr(db, 'borrow', lambda: nullcontext(conn))
    material_jobs.process({'map_id': 'm1', 'user_id': 'teacher-a', 'attempts': 1, 'claim_token': 'claim-1'})
    embed.assert_not_called()
    assert original.exists()
    assert cur.execute.call_args_list[0].args[1][0] == 'needs_attention'
    assert cur.execute.call_args_list[0].args[1][-1] == 'claim-1'


def test_reclaimed_material_worker_cannot_publish_derived_content(monkeypatch):
    cur = MagicMock()
    cur.__enter__.return_value = cur
    cur.fetchone.return_value = {'status': 'processing', 'claim_token': 'new-worker'}
    conn = MagicMock()
    conn.cursor.return_value = cur
    monkeypatch.setattr(db, 'transaction', lambda: nullcontext(conn))
    chunks = MagicMock()
    progress = MagicMock()
    monkeypatch.setattr(db, 'replace_curriculum_chunks', chunks)
    monkeypatch.setattr(db, 'replace_curriculum_progress', progress)
    assert material_jobs.publish({'map_id': 'm1', 'user_id': 'a', 'claim_token': 'old-worker'}, {'subject': 'English'}, ['text'], [[0.1]], []) is False
    chunks.assert_not_called()
    progress.assert_not_called()
    assert cur.execute.call_count == 1
