#!/usr/bin/env bash
# restore-drill.sh — CP-10 "tested restore" evidence (NIST 800-171 3.8.9 / CP-9/10).
#
# Proves the pgBackRest backups in the MinIO S3 repo are RECOVERABLE: restores the
# latest backup into a SCRATCH datadir in a SCRATCH postgres container (the live
# cluster is never touched), starts it, and runs a verification query — row counts on
# a couple of tables and a hard assertion that audit_logs is present (the AU-9 store).
#
# Exit 0 + "RESTORE-DRILL: PASS" only if the scratch cluster starts and the
# verification query succeeds. Safe to run repeatedly; it tears down the scratch
# container + scratch volume at the end (and on error via trap).
#
# Usage:  scripts/dsop/restore-drill.sh
# Env:    PROJECT (compose project, default cosmos-v2), the same PGBACKREST_* /
#         S3_* / cipher env the stack uses (sourced from ./.env if present).
set -uo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$PWD"
DOCKER="sudo docker"

# Source .env so the repo creds + cipher pass match the running stack.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

PROJECT="${PROJECT:-cosmos-v2}"
NETWORK="${PROJECT}_default"
PG_IMAGE="cosmos-v2-postgres:dev"
SCRATCH_NAME="cosmos-restore-drill"
SCRATCH_VOL="cosmos-restore-drill-data"

S3_ACCESS_KEY="${S3_ACCESS_KEY:-cosmos-app}"
S3_SECRET_KEY="${S3_SECRET_KEY:-cosmos-app-secret}"
PGBACKREST_CIPHER_PASS="${PGBACKREST_CIPHER_PASS:-change-me-backup-cipher}"
S3_ENDPOINT_HOST="${S3_ENDPOINT_HOST:-cosmos-minio:9000}"

cleanup() {
  $DOCKER rm -f "$SCRATCH_NAME" >/dev/null 2>&1 || true
  $DOCKER volume rm "$SCRATCH_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> restore-drill: tearing down any stale scratch resources"
cleanup

echo "==> restore-drill: creating scratch volume + container (network=${NETWORK})"
$DOCKER volume create "$SCRATCH_VOL" >/dev/null

# Long-lived scratch container (no postgres yet — we restore into the empty datadir
# first, then start postgres by hand). Run as the postgres user via the image default.
$DOCKER run -d --name "$SCRATCH_NAME" \
  --network "$NETWORK" \
  -e PGBACKREST_REPO1_S3_KEY="$S3_ACCESS_KEY" \
  -e PGBACKREST_REPO1_S3_KEY_SECRET="$S3_SECRET_KEY" \
  -e PGBACKREST_REPO1_CIPHER_PASS="$PGBACKREST_CIPHER_PASS" \
  -e PGBACKREST_REPO1_S3_ENDPOINT="$S3_ENDPOINT_HOST" \
  -v "$SCRATCH_VOL:/var/lib/postgresql/data" \
  --entrypoint sleep \
  "$PG_IMAGE" infinity >/dev/null

# Helper to run a command in the scratch container. `bash -l` resets PATH and can drop
# the postgres bin dir, so pin it explicitly for the postgres-user helpers.
PG_BIN=/usr/lib/postgresql/16/bin
dex() { $DOCKER exec "$SCRATCH_NAME" "$@"; }
dex_pg() { $DOCKER exec -u postgres "$SCRATCH_NAME" "$@"; }
dex_pg_sh() { $DOCKER exec -u postgres "$SCRATCH_NAME" bash -c "export PATH=$PG_BIN:\$PATH; $1"; }

echo "==> restore-drill: rendering pgBackRest config in scratch container"
dex /usr/local/bin/render-pgbackrest-conf.sh

# Empty the scratch datadir (the volume is fresh, but be defensive about lost+found).
dex bash -lc 'rm -rf /var/lib/postgresql/data/* /var/lib/postgresql/data/.* 2>/dev/null || true'
dex bash -lc 'chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data'

echo "==> restore-drill: pgbackrest restore (latest backup) → scratch datadir"
if ! dex_pg pgbackrest --stanza=cosmos --log-level-console=info --delta restore; then
  echo "RESTORE-DRILL: FAIL (pgbackrest restore errored)"
  exit 1
fi

# A restored cluster needs recovery to complete then be promoted; restore writes a
# recovery signal + restore_command. Start postgres standalone (NOT the compose
# archive_command — point archive_mode off so the scratch node never writes to the
# shared repo) and let it recover, then promote.
echo "==> restore-drill: starting scratch postgres (recovery, archive_mode=off)"
dex_pg_sh 'pg_ctl -D /var/lib/postgresql/data -o "-c archive_mode=off -c hot_standby=on" -w -t 120 start' || true

# Wait for the cluster to accept connections (recovery may take a moment).
echo "==> restore-drill: waiting for scratch cluster to accept connections"
ok=0
for i in $(seq 1 30); do
  if dex_pg_sh 'pg_isready -q'; then ok=1; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "RESTORE-DRILL: FAIL (scratch cluster never became ready)"
  echo "---- scratch postgres log tail ----"
  dex bash -c 'tail -n 40 /var/lib/postgresql/data/log/* 2>/dev/null || tail -n 40 /var/lib/postgresql/data/pg_log/* 2>/dev/null || true'
  exit 1
fi

# If still in recovery, promote so we can query. The cluster's superuser role is `cosmos`
# (POSTGRES_USER), NOT the OS `postgres` user psql would default to — so pass -U cosmos.
dex_pg_sh 'psql -U cosmos -d cosmos -tAc "SELECT pg_is_in_recovery()" | grep -q t && pg_ctl -D /var/lib/postgresql/data promote || true' >/dev/null 2>&1 || true
sleep 2

echo "==> restore-drill: VERIFICATION QUERY (row counts; audit_logs must exist)"
VERIFY_SQL="SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name='audit_logs') AS has_audit_logs, (SELECT count(*) FROM information_schema.tables WHERE table_name='egress_decisions') AS has_egress, (SELECT count(*) FROM organizations) AS organizations, (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM audit_logs) AS audit_rows;"
echo "----------------------------------------"
if ! dex_pg_sh "psql -U cosmos -d cosmos -v ON_ERROR_STOP=1 -c \"$VERIFY_SQL\""; then
  echo "RESTORE-DRILL: FAIL (verification query errored)"
  exit 1
fi
echo "----------------------------------------"

# Hard assert audit_logs is present (the AU-9 store) — the restore is only "good"
# for compliance if the audit trail came back.
HAS_AUDIT=$(dex_pg_sh "psql -U cosmos -d cosmos -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_name='audit_logs'\"")
if [ "${HAS_AUDIT//[[:space:]]/}" != "1" ]; then
  echo "RESTORE-DRILL: FAIL (audit_logs table not present after restore)"
  exit 1
fi

echo "RESTORE-DRILL: PASS — scratch cluster restored from MinIO repo, audit_logs present, verification query OK."
