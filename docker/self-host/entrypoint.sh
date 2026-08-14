#!/bin/sh
set -eu

# A named Docker volume is initially owned by root.  Adjust only the explicit
# Workspace volume before dropping privileges; the Server process itself never
# runs as root.
if [ -d /var/lib/samurai ]; then
  chown -R samurai:samurai /var/lib/samurai
fi

exec runuser -u samurai -- "$@"
