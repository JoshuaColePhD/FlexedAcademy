"""Exercise local generation backpressure without OpenAI or a database.

This measures the queue's behavior under a Sunday-evening burst. It is safe to
run from a laptop and does not send requests to production. It does not replace
an authenticated staging HTTP test, which should be run before changing the
Render instance size or concurrency settings.
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.errors import AppError
from backend.generation_queue import GenerationQueue


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * percentile))
    return ordered[index]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests", type=int, default=25, help="Burst size (default: 25)")
    parser.add_argument("--users", type=int, default=25, help="Distinct users in the burst (default: 25)")
    parser.add_argument("--max-concurrent", type=int, default=2)
    parser.add_argument("--service-time", type=float, default=0.25, help="Simulated generation seconds")
    parser.add_argument("--queue-size", type=int, default=40)
    args = parser.parse_args()
    if args.requests < 1 or args.users < 1 or args.service_time < 0:
        parser.error("requests, users, and service-time must be positive")

    queue = GenerationQueue(
        max_concurrent=args.max_concurrent,
        max_per_user=1,
        max_queue=max(args.queue_size, args.requests),
        max_queue_per_user=max(2, args.requests),
        min_start_interval=0,
    )

    def run_one(index: int) -> dict:
        user_id = f"load-test-user-{index % args.users}"
        enqueued_at = time.perf_counter()
        try:
            lease = queue.enqueue(user_id)
        except AppError as exc:
            return {"status": "rejected", "code": exc.code, "wait_ms": 0.0}
        if not lease.wait(timeout=max(30.0, args.requests * args.service_time + 5)):
            lease.cancel()
            return {"status": "timeout", "code": "queue_timeout", "wait_ms": 0.0}
        wait_ms = (time.perf_counter() - enqueued_at) * 1000
        try:
            time.sleep(args.service_time)
        finally:
            lease.release()
        return {"status": "completed", "code": None, "wait_ms": wait_ms}

    started_at = time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(args.requests, 64)) as pool:
        futures = [pool.submit(run_one, index) for index in range(args.requests)]
        results = [future.result() for future in as_completed(futures)]
    elapsed = time.perf_counter() - started_at

    waits = [r["wait_ms"] for r in results if r["status"] == "completed"]
    completed = len(waits)
    rejected = sum(r["status"] == "rejected" for r in results)
    timed_out = sum(r["status"] == "timeout" for r in results)
    print(f"requests={args.requests} users={args.users} max_concurrent={args.max_concurrent}")
    print(f"completed={completed} rejected={rejected} timed_out={timed_out}")
    print(f"elapsed_seconds={elapsed:.3f} throughput_per_second={completed / elapsed:.2f}")
    if waits:
        print(
            "queue_wait_ms="
            f"p50:{statistics.median(waits):.1f} "
            f"p95:{_percentile(waits, 0.95):.1f} "
            f"max:{max(waits):.1f}"
        )
    return 0 if completed == args.requests and timed_out == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
