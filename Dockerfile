# NOT YET BUILT. There is no Docker on the machine this was written on, so the
# paths are verified to exist but the build itself is unrun. Expect one or two
# small fixes on the first `docker build`.
#

# One image: the API also serves the built frontend, so there is one origin,
# one deploy, and the session cookie stays SameSite=Lax rather than needing the
# cross-site relaxation a split frontend/backend would force.
#
# Portable on purpose. This is what Cloudflare Containers wants, and the same
# image runs on Fly, Railway, or Render-as-Docker — so the hosting decision
# stops being a rewrite and becomes a `deploy` command.

# ── stage 1: the SPA ────────────────────────────────────────────────────────
FROM node:22-slim AS web
WORKDIR /app/frontend

# Vite INLINES this at build time — it is not readable at runtime, so it has to
# be present here or the Google button renders and silently fails.
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# ── stage 2: the app ────────────────────────────────────────────────────────
FROM python:3.12-slim AS app
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# psycopg2-binary ships its own libpq, and every other dependency is a wheel —
# so there is no build toolchain here and the image stays small.
COPY pyproject.toml ./
COPY backend/ ./backend/
RUN pip install --no-cache-dir -e .

# Only the parsed chunk files, which retrieval.load_chunks() globs at runtime
# for the citation popover and the whole-plan revise. data/ as a whole is 307MB
# — data/db/ is the retired Chroma store and data/raw/ is the source PDFs, and
# neither is read by the running app. This is 36MB.
#
# The school calendar and the .docx builder live under backend/, already copied.
COPY data/processed/ ./data/processed/
COPY --from=web /app/frontend/dist ./frontend/dist

# Generated .docx land here. On a container host with an ephemeral filesystem
# this is scratch space, not storage: every plan's JSON is in Postgres and
# /api/plans/{id}/rebuild re-emits the document in ~37ms.
RUN mkdir -p plans && useradd -m -u 1000 app && chown -R app:app /app
USER app

# Cloudflare Containers, Fly and Railway all inject PORT; 8080 is the fallback.
ENV PORT=8080
EXPOSE 8080

# Two workers, each with its own connection pool. The work is I/O-bound —
# waiting on OpenAI, then on Postgres — so this is about not letting one slow
# generation block another teacher's request, not about CPU.
CMD ["sh", "-c", "uvicorn backend.server:app --host 0.0.0.0 --port ${PORT:-8080} --workers 2 --timeout-keep-alive 75"]
