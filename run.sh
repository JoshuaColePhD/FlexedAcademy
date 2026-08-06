#!/usr/bin/env bash
# Start the backend for LOCAL development.
#
# --host 127.0.0.1 keeps this off the network. That used to be described as "the
# whole security boundary for this app: no auth" — no longer true. There is real
# auth (signed session cookies, PBKDF2, Google OAuth) and REQUIRE_LOGIN defaults
# to on, so binding to loopback is now defence in depth rather than the only
# defence. Production is render.yaml, which serves the built frontend from the
# same process.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x venv/bin/python ]]; then
  echo "No venv found. Create one:  python3 -m venv venv && venv/bin/pip install -e ." >&2
  exit 1
fi

# --reload is opt-in. It used to matter a great deal because a reload re-loaded
# a local sentence-transformers model; query embedding moved to the OpenAI API
# (see render.yaml), so HF_HUB_OFFLINE and TOKENIZERS_PARALLELISM are gone with
# it and a reload is now cheap.
RELOAD=""
[[ "${DEV_RELOAD:-0}" == "1" ]] && RELOAD="--reload"

# Build the frontend so it can be served entirely by the backend, bypassing Vite
if [[ ! -d "frontend/dist" ]] || [[ "${BUILD_UI:-0}" == "1" ]]; then
  echo "Building frontend..."
  (cd frontend && npm install && npm run build)
fi

exec venv/bin/uvicorn backend.server:app \
  --host 127.0.0.1 \
  --port "${API_PORT:-8010}" \
  $RELOAD
