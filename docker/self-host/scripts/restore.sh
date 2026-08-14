#!/bin/sh
set -eu
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

bundle_dir="${1:?Usage: restore.sh /backups/<bundle>}"
workspace_id="${2:?Usage: restore.sh /var/lib/samurai/backups/<bundle> <workspace-id-from-.env>}"

# The target ID must equal SAMURAI_SELF_HOST_WORKSPACE_ID in .env. Restore into
# a fresh compose deployment with SAMURAI_SELF_HOST_BOOTSTRAP_MODE=empty, then
# keep the source read-only until the Bundle count and file hashes verify.
docker compose stop server
# A fresh restore target may have an empty PostgreSQL volume. Run the admin
# migration container explicitly before the runtime-only import command.
docker compose run --rm migrate
if ! docker compose run --rm server \
  pnpm --filter @samurai-agent/server run workspace-server:cli -- \
  bundle-import "$bundle_dir" "$workspace_id"; then
  # A failed provisional import must not leave an otherwise usable Server
  # stopped. The source remains read-only until its operator decides otherwise.
  docker compose up -d server || true
  exit 1
fi
docker compose up -d server
