#!/usr/bin/env bash
# restore-to-point-drill.sh — VALIDATE a PRECISE point-in-time restore (CP-9/CP-10 + the
# §9.4 cutover pre-flip rollback evidence).
#
# Extends restore-drill.sh: instead of restoring the LATEST backup (replay to end of WAL),
# this restores to a SPECIFIC recovery target — a NAMED restore point (--target-name) or a
# TIMESTAMP (--target-time) — into a SCRATCH datadir in a SCRATCH container (the live cluster
# is NEVER touched), starts it (recovers + promotes AT the target), and then:
#   1. runs the same verification query as the base drill (row counts; asserts audit_logs
#      present — the AU-9 store);
#   2. asserts the cluster actually STOPPED RECOVERY AT/AFTER the target (it promoted out of
#      recovery — i.e. the recovery target was reachable; a target that can't be reached makes
#      a promote-action restore pause in recovery, which this catches).
#
# This is the pre-flip "rollback WOULD work" evidence: it proves the captured restore point is
# restorable BEFORE we flip. (For the cutover acceptance: rows inserted AFTER the captured point
# are ABSENT in the restored scratch cluster — PITR stopped at the point.)
#
# Exit 0 + "RESTORE-TO-POINT: PASS" only on success. Safe to run repeatedly; tears down the
# scratch container + scratch volume at the end (and on error via trap). NON-destructive: only
# a throwaway scratch cluster is ever restored — never the live one.
#
# Usage:
#   scripts/dsop/restore-to-point-drill.sh --target-name <restore-point-label>
#   scripts/dsop/restore-to-point-drill.sh --target-time "<YYYY-MM-DD HH:MM:SS+00>"
# Env: PROJECT (compose project, default cosmos-v2); STANZA (default cosmos); the same
#      PGBACKREST_* / S3_* / cipher env the stack uses (sourced from ./.env if present).
set -uo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$PWD"
DOCKER="sudo docker"

# ── args ──
TARGET_NAME=""
TARGET_TIME=""
TARGET_LSN=""   # optional: the LSN of the named restore point (from the snapshot record). Used to
                # pick the correct BASE backup (the latest whose start LSN precedes the target) so
                # recovery can replay FORWARD to the target — pgBackRest otherwise defaults to the
                # latest backup, which for a PAST target may start AFTER it ("recovery ended before
                # the target was reached"). For --target-time the base is picked by backup stop time.
STATE=""        # optional: a cutover state.json; .snapshot.lsn is read as TARGET_LSN if not given.
while [ $# -gt 0 ]; do
  case "$1" in
    --target-name) TARGET_NAME="$2"; shift 2 ;;
    --target-time) TARGET_TIME="$2"; shift 2 ;;
    --target-lsn)  TARGET_LSN="$2"; shift 2 ;;
    --state)       STATE="$2"; shift 2 ;;
    *) echo "restore-to-point-drill: unknown arg $1" >&2; exit 2 ;;
  esac
done
if [ -n "$TARGET_NAME" ] && [ -n "$TARGET_TIME" ]; then
  echo "restore-to-point-drill: pass EITHER --target-name OR --target-time, not both" >&2; exit 2
fi
if [ -z "$TARGET_NAME" ] && [ -z "$TARGET_TIME" ]; then
  echo "restore-to-point-drill: a target is REQUIRED — pass --target-name <label> or --target-time <ts>." >&2
  echo "  (A restore with NO target replays to the end of WAL and is NOT a point-in-time rollback.)" >&2
  exit 2
fi

# Source .env so the repo creds + cipher pass match the running stack.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

PROJECT="${PROJECT:-cosmos-v2}"
NETWORK="${PROJECT}_default"
STANZA="${STANZA:-cosmos}"
PG_IMAGE="cosmos-v2-postgres:dev"
SCRATCH_NAME="cosmos-restore-to-point-drill"
SCRATCH_VOL="cosmos-restore-to-point-drill-data"

S3_ACCESS_KEY="${S3_ACCESS_KEY:-cosmos-app}"
S3_SECRET_KEY="${S3_SECRET_KEY:-cosmos-app-secret}"
PGBACKREST_CIPHER_PASS="${PGBACKREST_CIPHER_PASS:-change-me-backup-cipher}"
S3_ENDPOINT_HOST="${S3_ENDPOINT_HOST:-cosmos-minio:9000}"

# Build the pgBackRest recovery-target flags (named OR time). A target is ALWAYS present here
# (validated above) — this drill never does a targetless replay-to-end.
if [ -n "$TARGET_NAME" ]; then
  TARGET_KIND="name"
  TARGET_VAL="$TARGET_NAME"
else
  TARGET_KIND="time"
  TARGET_VAL="$TARGET_TIME"
fi
echo "restore-to-point-drill: target ${TARGET_KIND}=\"${TARGET_VAL}\" (stanza=${STANZA})"

# If no --target-lsn was given but a --state was, read the captured restore-point LSN from it
# (snapshot-capture writes .snapshot.lsn). Used only to pick the correct base backup below.
if [ -z "$TARGET_LSN" ] && [ -n "$STATE" ] && [ -f "$STATE" ]; then
  TARGET_LSN="$(node -e 'try{const s=require(process.argv[1]);process.stdout.write((s.snapshot&&s.snapshot.lsn)||"")}catch(e){}' "$STATE" 2>/dev/null || true)"
  [ -n "$TARGET_LSN" ] && echo "restore-to-point-drill: read target LSN ${TARGET_LSN} from ${STATE} (.snapshot.lsn)"
fi

cleanup() {
  $DOCKER rm -f "$SCRATCH_NAME" >/dev/null 2>&1 || true
  $DOCKER volume rm "$SCRATCH_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> restore-to-point-drill: tearing down any stale scratch resources"
cleanup

echo "==> restore-to-point-drill: creating scratch volume + container (network=${NETWORK})"
$DOCKER volume create "$SCRATCH_VOL" >/dev/null

# Long-lived scratch container (no postgres yet — restore into the empty datadir first, then
# start postgres by hand). The base image entrypoint is bypassed (sleep) so nothing auto-boots.
$DOCKER run -d --name "$SCRATCH_NAME" \
  --network "$NETWORK" \
  -e PGBACKREST_REPO1_S3_KEY="$S3_ACCESS_KEY" \
  -e PGBACKREST_REPO1_S3_KEY_SECRET="$S3_SECRET_KEY" \
  -e PGBACKREST_REPO1_CIPHER_PASS="$PGBACKREST_CIPHER_PASS" \
  -e PGBACKREST_REPO1_S3_ENDPOINT="$S3_ENDPOINT_HOST" \
  -v "$SCRATCH_VOL:/var/lib/postgresql/data" \
  --entrypoint sleep \
  "$PG_IMAGE" infinity >/dev/null

PG_BIN=/usr/lib/postgresql/16/bin
dex() { $DOCKER exec "$SCRATCH_NAME" "$@"; }
dex_pg() { $DOCKER exec -u postgres "$SCRATCH_NAME" "$@"; }
dex_pg_sh() { $DOCKER exec -u postgres "$SCRATCH_NAME" bash -c "export PATH=$PG_BIN:\$PATH; $1"; }

echo "==> restore-to-point-drill: rendering pgBackRest config in scratch container"
dex /usr/local/bin/render-pgbackrest-conf.sh

# ── pick the correct BASE backup for the target (--set) ──
# pgBackRest defaults to the LATEST backup. For a target in the PAST relative to the latest
# backup (the usual cutover case: the pre-flip restore point precedes later incr backups), the
# latest backup STARTS after the target and recovery "ends before the target was reached". So we
# select the latest backup whose START precedes the target (by LSN for a named point, by stop
# time for a time target) and replay FORWARD from it to the target.
SET_ARG=""
INFO_JSON="$(dex_pg pgbackrest --stanza="$STANZA" info --output=json 2>/dev/null || true)"
if [ -n "$INFO_JSON" ]; then
  CHOSEN="$(printf '%s' "$INFO_JSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{
        const stanza=process.argv[1], kind=process.argv[2], lsn=process.argv[3], time=process.argv[4];
        const arr=JSON.parse(s); const st=Array.isArray(arr)?arr.find(x=>x.name===stanza):null;
        const backups=(st&&st.backup)||[];
        const lsnNum=(v)=>{ if(!v)return null; const [h,l]=String(v).split("/"); return BigInt("0x"+h)*(2n**32n)+BigInt("0x"+l); };
        let chosen=null;
        for(const b of backups){ // backups are oldest→newest
          if(kind==="name"){
            const tgt=lsnNum(lsn); const start=lsnNum(b.lsn&&b.lsn.start);
            if(tgt===null||start===null){ chosen=b; continue; } // no LSN info → fall back to latest
            if(start<=tgt) chosen=b; // latest whose start ≤ target LSN
          } else {
            const tgt=Date.parse(time); const stop=(b.timestamp&&b.timestamp.stop)?b.timestamp.stop*1000:null;
            if(isNaN(tgt)||stop===null){ chosen=b; continue; }
            if(stop<=tgt) chosen=b; // latest whose stop time ≤ target time
          }
        }
        if(chosen&&chosen.label) process.stdout.write(chosen.label);
      }catch(e){}
    });
  ' "$STANZA" "$TARGET_KIND" "$TARGET_LSN" "$TARGET_VAL" 2>/dev/null || true)"
  if [ -n "$CHOSEN" ]; then
    SET_ARG="--set=$CHOSEN"
    echo "restore-to-point-drill: selected base backup ${CHOSEN} (starts at/before the target; replay forward to it)"
  else
    echo "restore-to-point-drill: could not select a base backup from info — letting pgBackRest default (latest)"
  fi
fi

# Empty the scratch datadir (fresh volume, but be defensive about lost+found).
dex bash -lc 'rm -rf /var/lib/postgresql/data/* /var/lib/postgresql/data/.* 2>/dev/null || true'
dex bash -lc 'chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data'

echo "==> restore-to-point-drill: pgbackrest restore ${SET_ARG:+$SET_ARG }--type=${TARGET_KIND} --target=\"${TARGET_VAL}\" --target-action=promote → scratch datadir"
# --target-action=promote: recover up to the target then promote to a normal R/W cluster.
# --delta against a fresh datadir is a clean full restore (no existing files to delta against).
if ! dex_pg pgbackrest --stanza="$STANZA" --log-level-console=info --delta \
    ${SET_ARG:+$SET_ARG} \
    --type="$TARGET_KIND" --target="$TARGET_VAL" --target-action=promote restore; then
  echo "RESTORE-TO-POINT: FAIL (pgbackrest restore errored)"
  exit 1
fi

# Start postgres standalone (archive_mode=off so the scratch node never writes to the shared
# repo) and let it recover to the target + promote.
echo "==> restore-to-point-drill: starting scratch postgres (recovery to target, archive_mode=off)"
dex_pg_sh 'pg_ctl -D /var/lib/postgresql/data -o "-c archive_mode=off -c hot_standby=on" -w -t 120 start' || true

echo "==> restore-to-point-drill: waiting for scratch cluster to accept connections"
ok=0
for i in $(seq 1 45); do
  if dex_pg_sh 'pg_isready -q'; then ok=1; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "RESTORE-TO-POINT: FAIL (scratch cluster never became ready)"
  echo "---- scratch postgres log tail ----"
  dex bash -c 'tail -n 60 /var/lib/postgresql/data/log/* 2>/dev/null || tail -n 60 /var/lib/postgresql/data/pg_log/* 2>/dev/null || true'
  exit 1
fi

# ── assert recovery STOPPED AT/AFTER the target (the target was reachable + applied) ──
# With --target-action=promote, a REACHED target promotes the cluster out of recovery. If the
# target could not be reached (e.g. it is beyond the archived WAL), recovery pauses/stays in
# recovery — which we treat as FAIL (the point is not restorable as captured).
echo "==> restore-to-point-drill: asserting the cluster reached the target + promoted out of recovery"
for i in $(seq 1 30); do
  IN_REC="$(dex_pg_sh "psql -U cosmos -d cosmos -tAc 'SELECT pg_is_in_recovery()'" 2>/dev/null | tr -d '[:space:]')"
  if [ "$IN_REC" = "f" ]; then break; fi
  sleep 2
done
IN_REC="$(dex_pg_sh "psql -U cosmos -d cosmos -tAc 'SELECT pg_is_in_recovery()'" 2>/dev/null | tr -d '[:space:]')"
if [ "$IN_REC" != "f" ]; then
  echo "RESTORE-TO-POINT: FAIL (cluster did NOT promote out of recovery — the target ${TARGET_KIND}=\"${TARGET_VAL}\" was not reached)"
  echo "---- scratch postgres log tail ----"
  dex bash -c 'tail -n 60 /var/lib/postgresql/data/log/* 2>/dev/null || true'
  exit 1
fi
LAST_LSN="$(dex_pg_sh "psql -U cosmos -d cosmos -tAc 'SELECT pg_last_wal_replay_lsn()'" 2>/dev/null | tr -d '[:space:]')"
echo "    reached target + promoted (no longer in recovery). last replayed LSN: ${LAST_LSN:-n/a}"

# ── verification query (same as the base drill: row counts; audit_logs must exist) ──
echo "==> restore-to-point-drill: VERIFICATION QUERY (row counts; audit_logs must exist)"
VERIFY_SQL="SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name='audit_logs') AS has_audit_logs, (SELECT count(*) FROM information_schema.tables WHERE table_name='egress_decisions') AS has_egress, (SELECT count(*) FROM organizations) AS organizations, (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM audit_logs) AS audit_rows;"
echo "----------------------------------------"
if ! dex_pg_sh "psql -U cosmos -d cosmos -v ON_ERROR_STOP=1 -c \"$VERIFY_SQL\""; then
  echo "RESTORE-TO-POINT: FAIL (verification query errored)"
  exit 1
fi
echo "----------------------------------------"

# Hard assert audit_logs is present (the AU-9 store) — the restore is only "good" for
# compliance if the audit trail came back.
HAS_AUDIT=$(dex_pg_sh "psql -U cosmos -d cosmos -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_name='audit_logs'\"" 2>/dev/null)
if [ "${HAS_AUDIT//[[:space:]]/}" != "1" ]; then
  echo "RESTORE-TO-POINT: FAIL (audit_logs table not present after restore)"
  exit 1
fi

echo "RESTORE-TO-POINT: PASS — scratch cluster restored to ${TARGET_KIND}=\"${TARGET_VAL}\", reached + promoted at the target, audit_logs present, verification query OK."
