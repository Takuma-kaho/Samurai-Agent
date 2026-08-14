#!/bin/sh
set -eu
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

backup_id="${1:-backup-$(date -u +%Y%m%dT%H%M%SZ)}"
docker compose exec -T server pnpm --filter @samurai-agent/server run workspace-server:cli -- \
  bundle-export "/backups/${backup_id}"
docker compose exec -T server pnpm --filter @samurai-agent/server run workspace-server:cli -- \
  bundle-verify "/backups/${backup_id}"
