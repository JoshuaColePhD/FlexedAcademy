#!/usr/bin/env bash
# Per-boot startup for FlexedAcademy's Cloud Agent environment.
#
# Only brings up state that does not survive a fresh boot: the Postgres server
# process. All durable provisioning (packages, database, roles, extension,
# venv, frontend build) is done once in install.sh. The application's own
# migrate() runs at backend startup, so nothing here touches the schema.
set -euo pipefail

PG_VERSION=16

# Start the cluster if it is not already accepting connections. pg_ctlcluster
# is a no-op-ish "already running" on a warm boot, so tolerate its exit code.
if ! sudo -u postgres pg_isready -q 2>/dev/null; then
  sudo pg_ctlcluster "${PG_VERSION}" main start || true
fi

for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q 2>/dev/null; then
    echo "Postgres ${PG_VERSION} is ready."
    exit 0
  fi
  sleep 1
done

echo "warning: Postgres did not become ready within 30s" >&2
exit 0
