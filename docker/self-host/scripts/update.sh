#!/bin/sh
set -eu
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

./scripts/backup.sh
# The Server never receives the owner DB URL, so apply migrations through the
# short-lived admin container before replacing the runtime process.
docker compose build --pull migrate server
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d --remove-orphans server
