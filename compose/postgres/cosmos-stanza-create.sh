#!/bin/bash
# First-run helper: create the pgBackRest stanza in the MinIO repo, then flip the local
# marker that enables real WAL archiving (see pgbackrest-archive-push.sh) and take the initial FULL
# backup. Idempotent — re-running is safe (stanza-create is a no-op if it exists).
#
# Run inside the postgres container after the stack is healthy:
#   docker compose exec -u postgres cosmos-postgres /usr/local/bin/cosmos-stanza-create.sh
set -euo pipefail

echo "==> pgbackrest stanza-create (stanza=cosmos) → MinIO repo"
pgbackrest --stanza=cosmos --log-level-console=info stanza-create

# Enable archiving from here on (pgbackrest-archive-push.sh gates on this marker).
touch /var/lib/pgbackrest/.stanza-ready
echo "==> stanza ready — WAL archiving enabled (marker /var/lib/pgbackrest/.stanza-ready)."

echo "==> initial FULL backup"
pgbackrest --stanza=cosmos --type=full --log-level-console=info backup

echo "==> pgbackrest info:"
pgbackrest --stanza=cosmos info
