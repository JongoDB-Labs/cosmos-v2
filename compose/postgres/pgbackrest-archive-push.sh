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
MARKER=/var/lib/pgbackrest/.stanza-ready

if [ -f "$MARKER" ]; then
  # Steady state: real push (async per pgbackrest.conf; returns fast).
  exec pgbackrest --stanza=cosmos archive-push "$WAL_PATH"
fi

echo "archive-push: stanza 'cosmos' not ready yet — skipping $WAL_PATH (pre-stanza bootstrap; run the stanza-create helper to enable archiving)" >&2
exit 0
