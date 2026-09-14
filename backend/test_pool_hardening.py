"""Contracts that keep generate_stream + in-process DOCX inside a 1c-2g box.

These stay DB-free: they inspect the pool/queue/worker policy and exercise
the generation queue without opening Postgres.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

from backend import db, retrieval, service
from backend.generation_queue import GenerationQueue

HERE = Path(__file__).resolve().parent
DB_SOURCE = HERE.joinpath("db.py").read_text()
SERVER_SOURCE = HERE.joinpath("server.py").read_text()
SERVICE_SOURCE = HERE.joinpath("service.py").read_text()


def test_borrow_always_rolls_back_before_returning_to_the_pool():
    start = DB_SOURCE.index("def borrow")
    end = DB_SOURCE.index("def migrate", start)
    body = DB_SOURCE[start:end]
    assert "conn.rollback()" in body
    assert "timeout: float" in body
    assert body.rfind("conn.rollback()") > body.rfind("yield conn")


def test_document_claim_uses_a_short_pool_wait():
    assert db._DOCUMENT_CLAIM_TIMEOUT_S <= 0.25
    assert db._DOCUMENT_CLAIM_TIMEOUT_S < db._BORROW_TIMEOUT_S
    start = DB_SOURCE.index("def claim_next_document_build")
    end = DB_SOURCE.index("def finish_document_build", start)
    body = DB_SOURCE[start:end]
    assert "borrow(timeout=_DOCUMENT_CLAIM_TIMEOUT_S)" in body
    assert "except TimeoutError:" in body
    assert "return None" in body


def test_document_worker_serializes_through_the_generation_slot():
    assert "run_claimed_document_build" in SERVER_SOURCE
    assert "enqueue_background" in SERVICE_SOURCE
    assert "release_process_memory" in SERVICE_SOURCE
    assert service.DOCUMENT_BUILD_QUEUE_USER.startswith("__")


def test_retrieval_leaves_a_pool_slot_for_auth():
    assert retrieval.retrieval_concurrency(pool_size=2, workers=2) == 1
    assert retrieval.retrieval_concurrency(pool_size=2, workers=1) == 1
    assert retrieval.retrieval_concurrency(pool_size=1, workers=4) == 1
    assert retrieval.retrieval_concurrency(pool_size=8, workers=3) == 3


def test_background_document_build_waits_behind_a_teacher():
    queue = GenerationQueue(
        max_concurrent=1,
        max_per_user=1,
        max_queue=2,
        max_queue_per_user=1,
        min_start_interval=0,
    )
    teacher = queue.enqueue("teacher-a")
    assert teacher.wait()
    background = queue.enqueue_background(service.DOCUMENT_BUILD_QUEUE_USER)
    started: list[bool] = []

    def wait_for_background() -> None:
        started.append(background.wait(timeout=0.4))

    waiter = threading.Thread(target=wait_for_background)
    waiter.start()
    time.sleep(0.05)
    assert started == []
    teacher.release()
    waiter.join(timeout=1)
    assert started == [True]
    background.release()


def test_background_tickets_do_not_consume_teacher_queue_caps():
    queue = GenerationQueue(
        max_concurrent=1,
        max_per_user=1,
        max_queue=1,
        max_queue_per_user=1,
        min_start_interval=0,
    )
    held = queue.enqueue("teacher-a")
    assert held.wait()
    queue.enqueue_background(service.DOCUMENT_BUILD_QUEUE_USER)
    extra = queue.enqueue("teacher-b")
    extra.cancel()
    held.release()


def test_release_process_memory_is_safe_without_libc_trim():
    service.release_process_memory()
