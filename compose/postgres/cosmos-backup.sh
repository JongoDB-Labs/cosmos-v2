#!/bin/bash
# Periodic Postgres backup one-shot (CP-9). Renders the pgBackRest config from env,
# then runs a backup of the `cosmos` stanza to the MinIO S3 repo. Type is incr by
# default (daily); pass PGBACKREST_BACKUP_TYPE=full for the weekly full.
#
# Runs in the cosmos-v2-postgres image. It connects to the LIVE postgres over libpq
# (PGHOST) for pg_backup_start/stop and reads the cluster files from the shared
# cosmos-pgdata volume (mounted at the same /var/lib/postgresql/data path).
#
# NOTE: the datadir must be readable by this container's postgres user (same uid as
# the postgres service, since it's the same image). The compose service mounts the
# pgdata volume for exactly this reason.
set -euo pipefail

/usr/local/bin/render-pgbackrest-conf.sh

# pgBackRest connects to PG via libpq using its own pg1-* settings. pg1-socket-path
# points at the SHARED socket dir so the backup_start/stop SQL works; the cluster
# files are read locally from the shared pgdata volume (pg1-path in the conf).
SOCKET_DIR="${PGBACKREST_PGHOST:-/var/run/cosmos-pgsock}"
TYPE="${PGBACKREST_BACKUP_TYPE:-incr}"

echo "==> pgBackRest backup (stanza=cosmos, type=${TYPE}) → MinIO repo"
exec gosu postgres pgbackrest \
  --stanza=cosmos \
  --pg1-socket-path="${SOCKET_DIR}" \
  "--type=${TYPE}" \
  backup
