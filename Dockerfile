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

# Vite inlines the public Turnstile site key into the signup bundle. Render
# exposes service variables as Docker build args, so explicitly forward this
# non-secret value into the frontend build. The Turnstile secret remains a
# runtime-only backend variable and must never be added here.
ARG VITE_TURNSTILE_SITE_KEY=""
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY

# Stripe's publishable key is safe to ship in the browser bundle. Secret and
# restricted keys remain runtime-only in the backend stage.
ARG VITE_STRIPE_PUBLISHABLE_KEY=""
ENV VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY

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

# Three system binaries the Python deps shell out to rather than reimplement:
# poppler-utils gives routes/misc.py's pdftotext (plain-text PDF extraction,
# used well before this image existed) and pdf2image's pdftoppm (rasterizing
# a page for OCR); tesseract-ocr is template_intake.py's OCR fallback for a
# scanned-image lesson-plan template. Neither was ever actually installed
# here or on the Render deploy this image is meant to replace — pdftotext
# would have failed at runtime the first time a teacher uploaded a PDF.
# --no-install-recommends keeps this from dragging in a full TeX/X11 stack.
#
# libreoffice-writer (headless `soffice --convert-to pdf`) is new for the
# automated builder-codegen pipeline (backend/builder/rasterize.py) — a
# generated document has to be rendered to an image so the vision judge can
# compare it against the real uploaded template before any generated builder
# is ever trusted for a real teacher. Only the Writer component, not the
# full `libreoffice` metapackage (Impress/Calc/Draw etc.), to keep the image
# from ballooning for capabilities this app never uses.
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils \
        tesseract-ocr \
        libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*

# psycopg2-binary ships its own libpq, and every other dependency is a wheel —
# so there is no other build toolchain needed here and the image stays small.
COPY pyproject.toml ./
COPY backend/ ./backend/
RUN pip install --no-cache-dir -e .

# data/processed/*.json (the parsed chunk files retrieval.load_chunks() globs
# at runtime) used to be COPYed in here, but they're no longer git-tracked at
# all — moved to Supabase Storage (backend/storage.py) once alcos_chunks.json
# alone hit 29MB, so `data/processed/` doesn't exist in the build context any
# more and this COPY would fail outright ("not found"). load_chunks() already
# calls storage.ensure_local() for every expected chunk file before globbing,
# restoring them from Supabase Storage on first use — nothing here needs to
# pre-seed that.
#
# The school calendar and the .docx builder live under backend/, already copied.
COPY --from=web /app/frontend/dist ./frontend/dist

# Generated .docx land here. On a container host with an ephemeral filesystem
# this is scratch space, not storage: every plan's JSON is in Postgres and
# /api/plans/{id}/rebuild re-emits the document in ~37ms.
RUN mkdir -p plans && useradd -m -u 1000 app && chown -R app:app /app
USER app

# Cloudflare Containers, Fly and Railway all inject PORT; 8080 is the fallback.
ENV PORT=8080
EXPOSE 8080

# One worker, not two — was 2 (each with its own connection pool, so one
# slow generation couldn't block another teacher's request), but each worker
# is a full separate process holding its OWN copy of the ~75MB standards
# corpus in memory (retrieval.py's load_chunks cache) plus its own Postgres
# pool, and on the free plan's 512MB that combination genuinely OOM'd the
# instance in production within minutes of this image going live — see the
# Render "exceeded its memory limit" alert. Single-worker trades some
# request-level isolation for actually staying up; revisit if/when this
# service is on a plan with real headroom (render.yaml's own comment tracks
# that decision).
CMD ["sh", "-c", "uvicorn backend.server:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --timeout-keep-alive 75"]
