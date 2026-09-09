import threading
import time

from backend.generation_jobs import cancel_job, get_job, start_or_attach


def test_follow_replays_events_after_publisher_finishes():
    events = []

    def worker(job):
        job.publish('data: {"status": "writing"}\n\n')
        job.publish('data: {"done": true}\n\n')
        job.complete(result={"done": True})

    job = start_or_attach("user-replay", "req-replay", worker)
    deadline = time.time() + 1
    while job.status == "running" and time.time() < deadline:
        time.sleep(0.01)
    events.extend(job.follow())
    assert any("writing" in item for item in events)
    assert any("done" in item for item in events)
    assert job.snapshot()["status"] == "done"


def test_start_or_attach_reuses_a_running_job():
    started = []

    def worker(job):
        started.append(job.request_id)
        time.sleep(0.05)
        job.complete(result={"done": True})

    first = start_or_attach("user-attach", "req-attach", worker)
    second = start_or_attach("user-attach", "req-attach", worker)
    assert first is second
    assert started == ["req-attach"]


def test_cancel_marks_a_registered_job_cancelled():
    def worker(job):
        job.publish('data: {"status": "writing"}\n\n')
        while not job.cancelled.is_set():
            time.sleep(0.01)

    live = start_or_attach("user-stop", "req-stop", worker)
    assert get_job("user-stop", "req-stop") is live
    assert cancel_job("user-stop", "req-stop") is True
    assert live.status == "cancelled"
    assert cancel_job("user-stop", "missing-id") is False


def test_cancel_releases_the_generation_lease():
    released = []

    class FakeLease:
        def release(self):
            released.append(True)

    started = threading.Event()

    def worker(job):
        job.lease = FakeLease()
        started.set()
        while not job.cancelled.is_set():
            time.sleep(0.01)

    live = start_or_attach("user-lease", "req-lease", worker)
    assert started.wait(timeout=1)
    assert cancel_job("user-lease", "req-lease") is True
    assert released == [True]
    assert live.lease is None
    assert live.status == "cancelled"
