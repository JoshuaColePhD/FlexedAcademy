"""Mirror data/processed/*chunks.json to Supabase Storage.

data/processed/ is gitignored (generated wholesale by the ingest scripts,
too large to track — alcos_chunks.json alone is 29MB) and Render's build
never runs ingestion, so production only ever has whatever *chunks.json
happens to be committed to git. Run this after any re-ingest so
backend/retrieval.py's load_chunks() can restore the current files via
storage.ensure_local() on the next deploy, whether or not they're tracked.

Usage: python scripts/upload_chunks_to_storage.py
"""
from pathlib import Path

from backend import storage
from backend.config import PROJECT_ROOT


def main() -> None:
    if not storage.configured():
        raise SystemExit(
            "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — nothing to upload to."
        )
    processed = PROJECT_ROOT / "data" / "processed"
    paths = sorted(processed.glob("*chunks.json"))
    if not paths:
        raise SystemExit(f"No *chunks.json files found under {processed}")
    for path in paths:
        size_mb = path.stat().st_size / 1_000_000
        print(f"uploading {path.name} ({size_mb:.1f}MB)...")
        storage.mirror_file(path)
    print(f"done — {len(paths)} file(s) mirrored to Supabase Storage.")


if __name__ == "__main__":
    main()
