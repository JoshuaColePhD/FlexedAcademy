#!/usr/bin/env bash
# Start the backend. Nothing previously specified a port — the frontend just
# assumed 8000.
#
# --host 127.0.0.1 (not uvicorn's 0.0.0.0 default) is the whole security boundary
# for this app: no auth, no rate limiting, not reachable from the network.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x venv/bin/python ]]; then
  echo "No venv found. Create one:  python3 -m venv venv && venv/bin/pip install -e ." >&2
  exit 1
fi

# The embedding model is already on disk — chroma_db/ can't exist without it. Left
# online, sentence-transformers revalidates ~20 files against huggingface.co on
# every start, which adds ~10s and makes booting depend on network reachability.
# Set HF_HUB_OFFLINE=0 if you ever need to fetch a different model.
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export TOKENIZERS_PARALLELISM=false

# --reload is opt-in: a reload re-loads the embedding model, so the server stops
# answering for several seconds after every save.
RELOAD=""
[[ "${DEV_RELOAD:-0}" == "1" ]] && RELOAD="--reload"

exec venv/bin/uvicorn backend.server:app \
  --host 127.0.0.1 \
  --port "${API_PORT:-8010}" \
  $RELOAD
