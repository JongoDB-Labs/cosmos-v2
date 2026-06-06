#!/bin/bash
# archive_command wrapper. Postgres invokes this for every completed WAL segment.
#
# Why a wrapper: the official postgres image runs a TEMPORARY server during first-boot
# bootstrap (initdb + init scripts) BEFORE the stanza exists. With archive_mode=on,
# Postgres will not finish its bootstrap shutdown until archive_command returns, and a
# raw `pgbackrest archive-push` (or even an S3 `info` probe) there blocks on the repo
# and stalls bootstrap so the cluster never reaches normal running mode.
#
# Gate purely on a LOCAL marker file (no S3 call on the hot path): until the operator
# has run the stanza-create helper (which creates the marker after a successful
# `pgbackrest stanza-create`), we exit 0 immediately so bootstrap completes. Postgres
# retains the WAL; the first backup after stanza-create captures a consistent base.
# This pre-stanza window is operator-bounded (stanza-create is the documented first
# step), NOT a steady-state RPO gap.
set -uo pipefail

WAL_PATH="$1"
# The marker + the stanza ledger both live under /var/lib/pgbackrest, which is mounted on
# a NAMED volume (cosmos-pgbackrest-state) so they SURVIVE container recreate. Were this
# on the container's writable layer, a recreate would wipe the marker and every branch
# below would silently skip → un-archived WAL recycled → PITR/RPO hole.
MARKER=/var/lib/pgbackrest/.stanza-ready
# Local evidence that real async archiving has already been running: pgBackRest creates
# this spool dir for the stanza on its first real archive-push. Its presence means we are
# PAST first-boot bootstrap (the temp bootstrap server never reaches a real push), so a
# missing marker here is an anomaly — NOT pre-stanza bootstrap — and we must not skip.
SPOOL_STANZA=/var/spool/pgbackrest/archive/cosmos

if [ -f "$MARKER" ]; then
  # Steady state: real push (async per pgbackrest.conf; returns fast).
  exec pgbackrest --stanza=cosmos archive-push "$WAL_PATH"
fi

# Defense in depth: the marker is missing but the async spool for this stanza EXISTS —
# i.e. real archiving has already run, so we are NOT in pre-stanza bootstrap. Do NOT
# silently drop WAL; push for real (archive_command will fail loudly + Postgres retains
# the segment if the repo is unreachable, rather than recycling un-archived WAL).
if [ -d "$SPOOL_STANZA" ]; then
  echo "archive-push: marker missing but async spool for stanza 'cosmos' present — archiving $WAL_PATH for real (refusing to silently drop WAL post-stanza)" >&2
  exec pgbackrest --stanza=cosmos archive-push "$WAL_PATH"
fi

echo "archive-push: stanza 'cosmos' not ready yet — skipping $WAL_PATH (pre-stanza bootstrap; run the stanza-create helper to enable archiving)" >&2
exit 0
