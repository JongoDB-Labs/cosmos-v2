#!/usr/bin/env bash
# ============================================================================
# COSMOS v2 — deliberate single-shot PROD deploy (docker compose stack).
#
#   bash .deploy/deploy-v2.sh          # DRY-RUN — preflight + plan only, changes NOTHING
#   bash .deploy/deploy-v2.sh go       # REAL deploy
#
# Topology served: Cloudflare tunnel -> nginx(:8080) -> caddy(reverse-proxy, :8090)
#                  -> app(cosmos:3000) -> postgres(docker) + MinIO.
#
# cosmos-v2 is a LOCAL-ONLY repo (no git remote) — `docker build` uses the working
# tree as its context, so the deploy builds whatever is checked out HERE (commit your
# changes first so the deployed image is reproducible from a known SHA).
#
# REAL run, in order: pre-deploy logical pg_dump (rollback point) -> build app+migrate
# images from the working tree -> `prisma migrate deploy` (owner role, via the migrate
# service) -> recreate the app+proxy containers -> health-gate at :8090. A build/migrate
# failure leaves the OLD container running (compose only swaps on success).
#
# This is INTENTIONALLY manual. Auto-deploy-on-push to a live gov prod is an opt-in
# decision — the old v1 webhook (cosmos-deploy.service) is stopped+disabled. To wire
# push-to-deploy later, have the webhook invoke this script with `go` (health-gated).
# ============================================================================
set -uo pipefail

REPO=/home/defcon/cosmos-v2
HEALTH="http://127.0.0.1:8090/api/health"
PGBRIDGE="postgresql://cosmos:cosmos@127.0.0.1:55432/cosmos"   # v2-pg-bridge (host->docker pg)
BACKUPDIR="$REPO/.deploy/backups"
MODE="${1:-dry}"
TS="$(date -u +%Y%m%d-%H%M%S)"
DC="sudo docker compose"

say(){ printf '\n=== %s ===\n' "$*"; }
fail(){ printf '\n❌ ABORT: %s\n' "$*" >&2; }

cd "$REPO" || { fail "no $REPO"; exit 1; }

say "PREFLIGHT (read-only)"
HEADV=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
echo "local HEAD version    : $HEADV ($(git rev-parse --short HEAD))"
[ "$DIRTY" != "0" ] && echo "⚠️  working tree DIRTY ($DIRTY uncommitted change(s)) — the build includes them; commit for a reproducible deploy."
echo "live :8090 now        : $(curl -s --max-time 5 "$HEALTH" 2>/dev/null | head -c 160 || echo 'no response')"
# pending migrations = present in the working tree but not yet applied to the live DB
APPLIED=$(psql "$PGBRIDGE" -tAc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null | sort -u) || { fail "cannot read _prisma_migrations via $PGBRIDGE"; exit 1; }
LOCALMIGS=$(ls -1 prisma/migrations 2>/dev/null | grep -E '^[0-9]+_' | sort -u)
PENDING=$(comm -23 <(printf '%s\n' "$LOCALMIGS") <(printf '%s\n' "$APPLIED"))
echo "--- migrations pending on the live DB ---"
printf '%s\n' "${PENDING:-(none — code-only deploy)}"

if [ "$MODE" != "go" ]; then
  say "DRY-RUN — nothing changed. Re-run with:  bash .deploy/deploy-v2.sh go"
  exit 0
fi

trap 'echo; echo "⚠️  interrupted mid-deploy — inspect container + DB state before retrying."; exit 130' INT TERM

MAINV="$HEADV"
say "1) PRE-DEPLOY SNAPSHOT (logical pg_dump — rollback point)"
mkdir -p "$BACKUPDIR"
DUMP="$BACKUPDIR/v2-predeploy-$TS.dump"
pg_dump "$PGBRIDGE" -Fc -f "$DUMP" 2>/dev/null && echo "dumped: $DUMP ($(du -h "$DUMP" | cut -f1))" \
  || { fail "pg_dump failed — refusing to deploy without a rollback point"; exit 1; }

say "2) BUILD images (app + migrate) — old container still serving"
$DC build cosmos 2>&1 | tail -3 || { fail "app image build failed — old container untouched"; exit 1; }
sudo docker build --target migrate -t cosmos-v2-migrate:dev . 2>&1 | tail -3 || { fail "migrate image build failed"; exit 1; }

say "3) MIGRATE (owner role)"
if [ -n "$PENDING" ]; then
  $DC run --rm cosmos-migrate npx prisma migrate deploy 2>&1 | grep -viE 'deprecated|prisma-config|pris\.ly' \
    || { fail "migrate deploy FAILED (per-migration transactional → failed one rolled back). Old container still serving the prior schema. Inspect before retry."; exit 1; }
else
  echo "(no pending migrations — skipping)"
fi

say "4) RECREATE app + proxy with the new image"
$DC up -d cosmos reverse-proxy 2>&1 | tail -4 || { fail "compose up failed"; exit 1; }
echo "waiting 12s for the app to bind..."; sleep 12

say "5) HEALTH GATE"
H=$(curl -s --max-time 10 "$HEALTH" 2>/dev/null || echo "")
echo "health: $H"
echo "$H" | grep -q '"db":"up"' && echo "$H" | grep -q "\"version\":\"$MAINV\"" \
  || { fail "HEALTH CHECK FAILED (expected version $MAINV, db up). ROLLBACK: 'git reset --hard <prev>' + re-run, and/or restore $DUMP:  pg_restore --clean --if-exists -d \"$PGBRIDGE\" $DUMP"; exit 1; }

say "DONE"
echo "✅ v2 deploy complete — :8090 serving $MAINV (db up). Public origin unchanged (nginx already -> :8090)."
echo "   rollback point: $DUMP"
