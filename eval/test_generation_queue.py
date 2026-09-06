#!/usr/bin/env python3
"""Small deterministic checks for burst pacing/backpressure.

This avoids the network and database entirely. The important contract is that
one user can queue a burst, only one of that user's jobs runs at a time, and a
second user can take the next global slot instead of being starved forever.
"""
from __future__ import annotations

import threading
import time

from backend.errors import AppError
from backend.generation_queue import GenerationQueue


def main() -> int:
    queue = GenerationQueue(
        max_concurrent=1,
        max_per_user=1,
        max_queue=5,
        max_queue_per_user=2,
        min_start_interval=0,
    )

    first = queue.enqueue("teacher-a")
    assert first.wait(), "first ticket should start immediately"
    second = queue.enqueue("teacher-a")
    assert second.position == 1

    started: list[bool] = []

    def wait_for_second() -> None:
        started.append(second.wait(timeout=1))

    waiter = threading.Thread(target=wait_for_second)
    waiter.start()
    time.sleep(0.03)
    assert not started, "same-user work must wait for the active job"
    first.release()
    waiter.join(timeout=1)
    assert started == [True]
    second.release()

    held = queue.enqueue("teacher-a")
    assert held.wait()
    queue.enqueue("teacher-a")
    queue.enqueue("teacher-a")
    queue.enqueue("teacher-b")
    try:
        queue.enqueue("teacher-a")
    except AppError as exc:
        assert exc.code == "generation_queue_busy"
    else:
        raise AssertionError("per-user queue limit should be enforced")
    held.release()

    print("PASSED — burst requests pace through the generation queue.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
