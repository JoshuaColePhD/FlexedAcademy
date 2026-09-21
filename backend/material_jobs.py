"""Durable, bounded processing of teacher uploads. Original files are saved first."""
from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from . import curriculum, db, embeddings, storage
from .entitlement import require_entitlement
from .errors import AppError
from .generation_queue import generation_queue

log = logging.getLogger(__name__)


def enqueue(map_id: str, user_id: str) -> str:
    with db.borrow() as conn:
        with conn.cursor() as cur:
            cur.execute('''INSERT INTO material_ingest_jobs(map_id,user_id) VALUES (%s,%s)
                ON CONFLICT(map_id) DO UPDATE SET
                status=CASE WHEN material_ingest_jobs.status='processing' THEN 'processing' ELSE 'queued' END,
                attempts=CASE WHEN material_ingest_jobs.status IN ('queued','processing') THEN material_ingest_jobs.attempts ELSE 0 END,
                claim_token=CASE WHEN material_ingest_jobs.status='processing' THEN material_ingest_jobs.claim_token ELSE NULL END,
                available_at=now(),updated_at=now()
                WHERE material_ingest_jobs.user_id=EXCLUDED.user_id RETURNING status''', (map_id, user_id))
            status = cur.fetchone()['status']
            cur.execute("UPDATE curriculum_maps SET processing_status=%s,processing_error=NULL WHERE id=%s AND user_id=%s", (status, map_id, user_id))
        conn.commit()
    return status


@contextmanager
def maintain_lease(job: dict):
    """Keep a slow extraction/embedding job from being reclaimed while alive."""
    stopped = threading.Event()

    def heartbeat():
        while not stopped.wait(30):
            try:
                with db.as_user(job['user_id']):
                    db._write("UPDATE material_ingest_jobs SET updated_at=now() WHERE map_id=? AND user_id=? AND claim_token=? AND status='processing'",
                              (job['map_id'], job['user_id'], job['claim_token']))
            except Exception:  # noqa: BLE001 — heartbeat failures must not kill the processing worker
                log.warning('could not renew material lease map_id=%s', job['map_id'])

    thread = threading.Thread(target=heartbeat, name='material-lease', daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join(timeout=1)


def claim() -> dict | None:
    with db.borrow() as conn:
        with conn.cursor() as cur:
            # Revisited every poll, including after an early restart.
            cur.execute("UPDATE material_ingest_jobs SET status='queued',claim_token=NULL,available_at=now() WHERE status='processing' AND updated_at < now()-interval '10 minutes'")
            cur.execute('''WITH next AS (SELECT map_id FROM material_ingest_jobs WHERE status='queued' AND available_at<=now()
              ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
              UPDATE material_ingest_jobs j SET status='processing', attempts=j.attempts+1,claim_token=%s,updated_at=now()
              FROM next WHERE j.map_id=next.map_id RETURNING j.*''', (uuid.uuid4().hex,))
            row = cur.fetchone()
        conn.commit()
    return dict(row) if row else None


def process(job: dict) -> None:
    from .routes.misc import read_text_from_path

    user_id, map_id = job['user_id'], job['map_id']
    with db.as_user(user_id), maintain_lease(job):
        row = db.get_curriculum_map(user_id, map_id)
        if not row:
            return
        db._write("UPDATE curriculum_maps SET processing_status='processing' WHERE id=? AND user_id=?", (map_id, user_id))
        try:
            require_entitlement(user_id)
            with generation_queue.slot(user_id):
                require_entitlement(user_id)
                path = Path(row['stored_path'])
                if not storage.ensure_local(path):
                    raise RuntimeError('The original file is unavailable. Upload it again.')
                text = read_text_from_path(path, path.suffix.lower())
                chunks = curriculum.chunk_text(text)
                if not chunks:
                    raise RuntimeError('No usable passages were extracted. Review the file and retry.')
                vectors = embeddings.embed_texts(chunks, user_id=user_id, kind='embed_curriculum_map')
                if len(vectors) != len(chunks):
                    raise RuntimeError('Not every passage could be indexed. Try again.')
                weeks = curriculum.parse_curriculum_progress(text, row['subject'], user_id) if row.get('kind') in ('pacing_guide', 'curriculum_map') else []
            publish(job, row, chunks, vectors, weeks)
            return
        except Exception as exc:  # noqa: BLE001 — persist a recoverable job state for any ingestion failure
            log.warning('material processing failed map_id=%s error_type=%s', map_id, type(exc).__name__)
            count, weeks = 0, []
            retry = job['attempts'] < 3 and not (isinstance(exc, AppError) and exc.status in (400, 401, 402, 403, 404, 422))
            status = 'queued' if retry else 'needs_attention'
            error = 'Processing was interrupted. We will retry automatically.' if retry else 'We could not finish reading this document. Retry processing or upload a clearer copy.'
            if isinstance(exc, AppError) and not retry:
                error = exc.message
        with db.borrow() as conn:
            with conn.cursor() as cur:
                cur.execute('''UPDATE material_ingest_jobs SET status=%s,updated_at=now(),available_at=now()+interval '30 seconds'
                    WHERE map_id=%s AND user_id=%s AND claim_token=%s RETURNING map_id''', (status, map_id, user_id, job['claim_token']))
                if cur.fetchone():
                    cur.execute('UPDATE curriculum_maps SET processing_status=%s,processing_error=%s,chunk_count=%s,week_count=%s WHERE id=%s AND user_id=%s',
                                (status, error, count, len(weeks), map_id, user_id))
            conn.commit()


def publish(job: dict, row: dict, chunks: list[str], vectors: list, weeks: list[dict]) -> bool:
    """Publish every derived row together, only while this worker owns the job."""
    map_id, user_id = job['map_id'], job['user_id']
    with db.transaction() as conn, conn.cursor() as cur:
        cur.execute("SELECT claim_token,status FROM material_ingest_jobs WHERE map_id=%s AND user_id=%s FOR UPDATE", (map_id, user_id))
        current = cur.fetchone()
        if not current or current['status'] != 'processing' or current['claim_token'] != job['claim_token']:
            return False
        db.replace_curriculum_chunks(map_id, user_id, list(zip(chunks, vectors)))
        db.replace_curriculum_progress(user_id, map_id, row['subject'], weeks)
        cur.execute("UPDATE curriculum_maps SET processing_status='ready',processing_error=NULL,chunk_count=%s,week_count=%s WHERE id=%s AND user_id=%s",
                    (len(chunks), len(weeks), map_id, user_id))
        cur.execute("UPDATE material_ingest_jobs SET status='ready',claim_token=NULL,updated_at=now() WHERE map_id=%s AND user_id=%s", (map_id, user_id))
    return True


async def worker_loop() -> None:
    while True:
        try:
            job = await asyncio.to_thread(claim)
            if job:
                await asyncio.to_thread(process, job)
                continue
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception('material worker could not claim work')
        await asyncio.sleep(5)
