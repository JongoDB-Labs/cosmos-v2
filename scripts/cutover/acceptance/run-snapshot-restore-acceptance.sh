#!/usr/bin/env bash
# scripts/cutover/acceptance/run-snapshot-restore-acceptance.sh
#
# DOCKER ACCEPTANCE for the PRE-FLIP RESTORE-POINT CAPTURE + VALIDATED PITR RESTORE
# (the cutover data rollback). Uses the REAL pgBackRest postgres stack (custom image +
# MinIO S3 repo + WAL archiving). NO production. Proves end-to-end:
#
#   1. stanza-create + a base backup (as the v2.3.0 backup-DR acceptance does).
#   2. snapshot-capture.mjs → a NAMED restore point "cutover-test-preflip" is created (LSN
#      recorded) + an incr pgBackRest backup; the snapshot record lands in the state file.
#   3. INSERT post-capture rows + force WAL archiving past the restore point.
#   4. restore-to-point-drill.sh --target-name cutover-test-preflip → a SCRATCH cluster
#      restores to the point; the POST-capture rows are ABSENT (PITR stopped at the point),
#      the verification query passes → "RESTORE-TO-POINT: PASS".
#   5. the orchestrator dry-run shows the capture step + the precise restore command in its
#      rollback plan.
#
# Requires sudo docker + the cosmos-v2-postgres:dev image (built by compose). Tears the stack
# down (down -v) on exit. Run from the repo root.
#
# NON-DESTRUCTIVE / SAFE: the only restore done is into a THROWAWAY scratch cluster — the live
# (compose) cluster is never restored. Nothing here points at production.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

D="sudo docker"
DC="sudo docker compose"
PROJECT="cosmos-v2"
STANZA="cosmos"
LABEL="cutover-test-preflip"
WORKDIR="$(mktemp -d /tmp/snap-restore-acc.XXXXXX)"
STATE="$WORKDIR/state.json"
STAMP="2026-06-07T12:00:00Z"
# The owner connection to the live compose cluster, reachable from the HOST via the postgres
# unix socket inside the container is awkward — instead we exec psql inside the container, and
# for snapshot-capture we connect over a published-port-free path by exec'ing tsx? No: tsx runs
# on the host. So publish nothing; snapshot-capture connects via a temporary host port we map.
PGPORT=55460
OWNER_URL="postgres://cosmos:cosmos@localhost:${PGPORT}/cosmos"
# pgbackrest exec prefix: run pgBackRest inside the live postgres container as the postgres user.
PGBACKREST_EXEC="$DC -p $PROJECT exec -T -u postgres cosmos-postgres"

PASS=0
FAIL=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }

# Exec helpers against the live postgres container.
dcpsql() { $DC -p "$PROJECT" exec -T cosmos-postgres psql -U cosmos -d cosmos "$@"; }

cleanup() {
  echo ""
  echo "── teardown ──"
  # remove any scratch publish container, then the whole stack + volumes.
  $D rm -f cosmos-snap-pgport >/dev/null 2>&1 || true
  $DC -p "$PROJECT" down -v >/dev/null 2>&1 || true
  rm -rf "$WORKDIR" || true
}
trap cleanup EXIT

echo "══════════════════════════════════════════════════════════════════════════════"
echo "  SNAPSHOT-CAPTURE + RESTORE-TO-POINT ACCEPTANCE (pgBackRest stack, synthetic)"
echo "══════════════════════════════════════════════════════════════════════════════"

# ── bring up ONLY the pgBackRest postgres stack (minio + init + postgres) ──
echo "── booting the pgBackRest postgres stack (cosmos-minio, minio-init, cosmos-postgres) ──"
$DC -p "$PROJECT" up -d --no-build cosmos-postgres >/dev/null 2>"$WORKDIR/up.err" \
  || { echo "compose up failed:"; cat "$WORKDIR/up.err"; exit 1; }

echo "── waiting for postgres to be healthy ──"
ready=0
for i in $(seq 1 60); do
  if $DC -p "$PROJECT" exec -T cosmos-postgres pg_isready -U cosmos >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = "1" ] && ok "postgres healthy" || { bad "postgres never became ready"; exit 1; }

# Publish a host port to the live cluster so the host-run snapshot-capture.mjs (uses node-pg)
# can connect. The compose service intentionally does NOT publish 5432, so bridge it with a
# transient socat container on the compose network that listens on the host.
echo "── publishing a temporary host port ${PGPORT} → cosmos-postgres:5432 for host tsx ──"
$D run -d --name cosmos-snap-pgport \
  --network "${PROJECT}_default" \
  -p "${PGPORT}:${PGPORT}" \
  alpine/socat \
  "TCP-LISTEN:${PGPORT},fork,reuseaddr" "TCP:cosmos-postgres:5432" >/dev/null 2>"$WORKDIR/socat.err" \
  || { echo "socat bridge failed:"; cat "$WORKDIR/socat.err"; }
# wait until the bridge actually accepts a postgres connection from the host.
br=0
for i in $(seq 1 30); do
  if PGCONNECT_TIMEOUT=2 psql "$OWNER_URL" -tAc "SELECT 1" >/dev/null 2>&1; then br=1; break; fi
  sleep 1
done
[ "$br" = "1" ] && ok "host port bridge up (host :${PGPORT} → cosmos-postgres:5432)" || bad "host port bridge never accepted a connection"

# ── apply v2 migrations to the live cluster (so audit_logs etc. exist) ──
echo "── applying v2 migrations (prisma migrate deploy) ──"
DATABASE_URL="$OWNER_URL" DIRECT_URL="$OWNER_URL" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/migrate.err" \
  || { echo "migrate failed:"; cat "$WORKDIR/migrate.err"; exit 1; }
ok "v2 migrations applied"

# ── seed a tiny bit of pre-capture data (an org + an audit row so the drill verifies counts) ──
echo "── seeding pre-capture rows ──"
dcpsql -v ON_ERROR_STOP=1 -c "
  INSERT INTO organizations (id, name, slug, created_at, updated_at)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Acme','acme', now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO audit_logs (id, org_id, action, entity, created_at)
  VALUES (gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PRE_CAPTURE_SEED', 'acceptance', now());
" >/dev/null 2>"$WORKDIR/seed.err" || { echo "seed failed:"; cat "$WORKDIR/seed.err"; }
PRE_AUDIT="$(dcpsql -tAc "SELECT count(*) FROM audit_logs" | tr -d '[:space:]')"
echo "    pre-capture audit_logs rows: $PRE_AUDIT"

echo ""
echo "════════════════════ 1. STANZA-CREATE + BASE (FULL) BACKUP ════════════════════"
if $DC -p "$PROJECT" exec -T -u postgres cosmos-postgres /usr/local/bin/cosmos-stanza-create.sh > "$WORKDIR/stanza.log" 2>&1; then
  ok "stanza-create + initial FULL backup"
else
  bad "stanza-create / base backup failed"; tail -40 "$WORKDIR/stanza.log"
fi
grep -q "stanza ready" "$WORKDIR/stanza.log" && ok "WAL archiving enabled (.stanza-ready marker)" || bad "stanza-ready marker not set"

echo ""
echo "════════════════════ 2. SNAPSHOT-CAPTURE (restore point + LSN + incr backup) ════════════════════"
CAPTURE_LOG="$WORKDIR/capture.log"
if npx tsx scripts/cutover/snapshot-capture.mjs \
     --db "$OWNER_URL" --label "$LABEL" --stamp "$STAMP" --state "$STATE" \
     --stanza "$STANZA" --pgbackrest-exec "$PGBACKREST_EXEC" 2>&1 | tee "$CAPTURE_LOG"; then
  ok "snapshot-capture ran"
else
  bad "snapshot-capture exited non-zero"; cat "$CAPTURE_LOG"
fi
grep -q "SNAPSHOT_CAPTURE " "$CAPTURE_LOG" && ok "machine line SNAPSHOT_CAPTURE emitted" || bad "no SNAPSHOT_CAPTURE machine line"
# the restore point LSN was recorded
CAP_LSN="$(node -e 'const s=require("'"$STATE"'");console.log(s.snapshot&&s.snapshot.lsn||"")' 2>/dev/null)"
[ -n "$CAP_LSN" ] && ok "restore point created — LSN recorded ($CAP_LSN)" || bad "no LSN recorded in state.snapshot"
# the state record has the label + a backup label (the incr backup ran)
CAP_LABEL="$(node -e 'const s=require("'"$STATE"'");console.log(s.snapshot&&s.snapshot.label||"")' 2>/dev/null)"
[ "$CAP_LABEL" = "$LABEL" ] && ok "state.snapshot.label = $LABEL" || bad "state.snapshot.label wrong: '$CAP_LABEL'"
CAP_BACKUP="$(node -e 'const s=require("'"$STATE"'");console.log(s.snapshot&&s.snapshot.backupLabel||"")' 2>/dev/null)"
[ -n "$CAP_BACKUP" ] && ok "incr backup recorded (backupLabel=$CAP_BACKUP)" || bad "no incr backup label recorded"
echo "    state.snapshot record:"
node -e 'console.log(JSON.stringify(require("'"$STATE"'").snapshot,null,2))' 2>/dev/null | sed 's/^/      /'

echo ""
echo "════════════════════ 3. INSERT POST-CAPTURE ROWS + archive WAL past the point ════════════════════"
dcpsql -v ON_ERROR_STOP=1 -c "
  INSERT INTO audit_logs (id, org_id, action, entity, created_at) VALUES (gen_random_uuid(),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','POST_CAPTURE_ROW_1','acceptance', now());
  INSERT INTO audit_logs (id, org_id, action, entity, created_at) VALUES (gen_random_uuid(),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','POST_CAPTURE_ROW_2','acceptance', now());
" >/dev/null 2>"$WORKDIR/post.err" || { echo "post-insert failed:"; cat "$WORKDIR/post.err"; }
POST_AUDIT="$(dcpsql -tAc "SELECT count(*) FROM audit_logs" | tr -d '[:space:]')"
echo "    audit_logs rows after post-capture inserts: $POST_AUDIT (was $PRE_AUDIT)"
[ "$POST_AUDIT" -gt "$PRE_AUDIT" ] && ok "post-capture rows present in the LIVE cluster ($PRE_AUDIT → $POST_AUDIT)" || bad "post-capture inserts did not land"
# force a WAL switch + an incr backup so the WAL holding both the restore point AND the
# post-capture rows is archived into the repo (the PITR target must be reachable in the repo).
dcpsql -tAc "SELECT pg_switch_wal()" >/dev/null 2>&1 || true
$DC -p "$PROJECT" exec -T -u postgres cosmos-postgres pgbackrest --stanza="$STANZA" --type=incr backup > "$WORKDIR/incr2.log" 2>&1 \
  && ok "post-capture WAL archived (incr backup #2)" || { bad "post-capture incr backup failed"; tail -20 "$WORKDIR/incr2.log"; }

echo ""
echo "════════════════════ 4. RESTORE-TO-POINT DRILL (scratch) — POST-capture rows ABSENT ════════════════════"
DRILL_LOG="$WORKDIR/drill.log"
if STANZA="$STANZA" bash scripts/dsop/restore-to-point-drill.sh --target-name "$LABEL" --state "$STATE" 2>&1 | tee "$DRILL_LOG"; then
  DRILL_RC=0
else
  DRILL_RC=$?
fi
grep -q "RESTORE-TO-POINT: PASS" "$DRILL_LOG" && ok "restore-to-point drill PASS (scratch restored to the named point)" || bad "drill did not report RESTORE-TO-POINT: PASS (rc=$DRILL_RC)"

# Prove the PITR stopped at the point: the scratch restore's audit_logs count == the PRE-capture
# count (the 2 post-capture rows are ABSENT). The drill's verification query printed audit_rows;
# parse it from the drill log (the "audit_rows" column of the verification SELECT).
SCRATCH_AUDIT="$(grep -A3 'has_audit_logs' "$DRILL_LOG" | grep -oE '[0-9]+' | tail -1)"
echo "    scratch (restored-to-point) audit_logs rows: ${SCRATCH_AUDIT:-?} | live now: $POST_AUDIT | pre-capture was: $PRE_AUDIT"
if [ -n "$SCRATCH_AUDIT" ] && [ "$SCRATCH_AUDIT" = "$PRE_AUDIT" ]; then
  ok "PITR stopped at the point — POST-capture rows ABSENT in the scratch restore ($SCRATCH_AUDIT == pre-capture $PRE_AUDIT, not live $POST_AUDIT)"
elif [ -n "$SCRATCH_AUDIT" ] && [ "$SCRATCH_AUDIT" -lt "$POST_AUDIT" ]; then
  ok "PITR excluded post-capture rows (scratch $SCRATCH_AUDIT < live $POST_AUDIT)"
else
  bad "scratch restore did NOT exclude the post-capture rows (scratch=${SCRATCH_AUDIT:-?}, live=$POST_AUDIT)"
fi

echo ""
echo "════════════════════ 5. ORCHESTRATOR DRY-RUN shows capture + precise restore command ════════════════════"
printf -- "-- fake schema dump (dry-run only checks existence)\n" > "$WORKDIR/dump.sql"
DRY_LOG="$WORKDIR/dryrun.log"
npx tsx scripts/cutover/orchestrate.mjs \
  --org aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa --slug acme \
  --source "$OWNER_URL" --target "$OWNER_URL" \
  --scratch "$OWNER_URL" --shadow "$OWNER_URL" \
  --prod-schema-dump "$WORKDIR/dump.sql" --state "$WORKDIR/dry-state.json" \
  --proxy-admin "http://localhost:2019" --stamp "$STAMP" \
  --snapshot-label "$LABEL" --stanza "$STANZA" \
  --pgbackrest-exec "$PGBACKREST_EXEC" --validate-snapshot \
  2>&1 | tee "$DRY_LOG" >/dev/null
grep -q "CAPTURE pre-flip restore point \"$LABEL\"" "$DRY_LOG" && ok "dry-run plan shows the CAPTURE step (5b)" || bad "dry-run plan missing the capture step"
grep -q "VALIDATE: restore-to-point-drill.sh --target-name \"$LABEL\"" "$DRY_LOG" && ok "dry-run plan shows the VALIDATE step (5c)" || bad "dry-run plan missing the validate step"
grep -q "pgbackrest --stanza=$STANZA --type=name --target=$LABEL --target-action=promote --delta restore" "$DRY_LOG" \
  && ok "dry-run plan shows the PRECISE rollback restore command" || bad "dry-run plan missing the precise restore command"
grep -q "NOT auto-run" "$DRY_LOG" && ok "dry-run labels the restore DESTRUCTIVE + operator-gated (NOT auto-run)" || bad "dry-run does not label the restore operator-gated"
echo "    ── the capture + rollback lines from the dry-run plan ──"
grep -E "5b\.|5c\.|then EMIT|pgbackrest --stanza" "$DRY_LOG" | sed 's/^/      /'

echo ""
echo "════════════════════════════════════════════════════════════"
echo "ACCEPTANCE RESULT: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
