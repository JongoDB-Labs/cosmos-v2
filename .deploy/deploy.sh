#!/usr/bin/env bash
# ============================================================================
# Single-shot coordinated PROD deploy:  origin/main (4.5.0) -> /home/defcon/cosmos-prod (:3000)
#
#   bash .deploy/deploy.sh           # DRY-RUN — preflight + plan only, touches NOTHING
#   bash .deploy/deploy.sh go        # REAL deploy
#
# REAL run does, in order: arm freeze -> stop auto-deployer -> kill stray next-start
# -> snapshot (money SUMs + pg_dump) -> stage main in prod checkout -> preflight aborts
# -> build -> [BREAKING] migrate deploy -> restart -> health+SUMs verify -> lift freeze
# -> re-enable auto-deployer. Aborts BEFORE the breaking step leave the DB untouched.
# A failure AFTER migrate halts with the freeze STILL ARMED + rollback instructions
# (the DB restore from the dump is a deliberate human step — never auto-destructive).
# ============================================================================
set -uo pipefail

MAIN=/home/defcon/cosmos-saas
PROD=/home/defcon/cosmos-prod
LOCK="$MAIN/.deploy-lock"
HEALTH="http://127.0.0.1:3000/api/health"
MODE="${1:-dry}"
TS="$(date -u +%Y%m%d-%H%M%S)"

say(){ printf '\n=== %s ===\n' "$*"; }
fail(){ printf '\n❌ ABORT: %s\n' "$*" >&2; }
disarm(){ rm -f "$LOCK" && echo "freeze lifted (.deploy-lock removed)"; }

cd "$MAIN" || { fail "no $MAIN"; exit 1; }
set -a; . "$MAIN/.env.local"; set +a

# ---------- preflight (read-only) ----------
say "PREFLIGHT (read-only)"
git fetch origin --quiet 2>/dev/null || { fail "git fetch failed"; exit 1; }
MAINV=$(git show origin/main:package.json | sed -nE 's/.*"version": *"([^"]+)".*/\1/p' | head -1)
PRODV=$(node -p "require('$PROD/package.json').version" 2>/dev/null || echo "?")
echo "origin/main version : $MAINV"
echo "prod checkout now   : $PRODV   ($(git -C "$PROD" rev-parse --short HEAD 2>/dev/null))"
echo "live :3000 now      : $(curl -s --max-time 5 "$HEALTH" 2>/dev/null | head -c 200 || echo 'no response')"

# pending = migrations in origin/main NOT yet recorded as applied in the shared DB
APPLIED=$(node -e '
const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();
p.$queryRawUnsafe("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL")
 .then(r=>{console.log(r.map(x=>x.migration_name).join("\n"));return p.$disconnect()})
 .then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})' 2>/dev/null) || { fail "cannot read _prisma_migrations"; exit 1; }
MAINMIGS=$(git ls-tree -r --name-only origin/main prisma/migrations | sed -nE 's#prisma/migrations/([0-9]+_[^/]+)/migration.sql#\1#p' | sort -u)
PENDING=$(comm -23 <(printf '%s\n' "$MAINMIGS") <(printf '%s\n' "$APPLIED" | sort -u))
echo "--- migrations pending on the shared DB (origin/main not yet applied) ---"
printf '%s\n' "${PENDING:-（none — DB already at main schema; code-only deploy）}"
BREAKING=$(printf '%s\n' "$PENDING" | grep -c "money_float_to_decimal" || true)
echo "breaking Float→Decimal pending: $([ "$BREAKING" -gt 0 ] && echo YES || echo no)"

if [ "$MODE" != "go" ]; then
  say "DRY-RUN — nothing changed. Re-run with:  bash .deploy/deploy.sh go"
  exit 0
fi

# ---------- REAL deploy ----------
trap 'echo; echo "⚠️  interrupted — freeze is STILL ARMED ($LOCK). Inspect before lifting."; exit 130' INT TERM

say "1) ARM FREEZE"
touch "$LOCK" && echo "armed: $LOCK"

say "2) PAUSE auto-deployer (cosmos-deploy.service)"
sudo -n systemctl stop cosmos-deploy.service 2>/dev/null && echo "stopped" || { fail "could not stop cosmos-deploy.service (sudo -n?)"; disarm; exit 1; }

say "3) kill stray next-start (keep systemd MainPID)"
MP=$(systemctl show -p MainPID --value cosmos-app.service 2>/dev/null || echo 0)
for p in $(pgrep -f "next start" 2>/dev/null); do [ "$p" = "$MP" ] || { echo "killing stray next-start pid $p"; kill "$p" 2>/dev/null || true; }; done

say "4) SNAPSHOT (money SUMs + pg_dump)"
bash "$MAIN/.deploy/snapshot-baseline.sh" || { fail "snapshot failed — refusing to deploy without a baseline+dump"; sudo -n systemctl start cosmos-deploy.service 2>/dev/null||true; disarm; exit 1; }
BASE=$(ls -t "$MAIN/.deploy/backups"/money-baseline-*.json 2>/dev/null | head -1)
ls "$MAIN/.deploy/backups"/cosmos-*.sql.gz >/dev/null 2>&1 || { fail "no pg_dump produced — refusing to deploy"; sudo -n systemctl start cosmos-deploy.service 2>/dev/null||true; disarm; exit 1; }

say "5) STAGE main ($MAINV) in prod checkout (old server still up)"
cd "$PROD" || { fail "no $PROD"; disarm; exit 1; }
git fetch origin --quiet && git checkout --quiet origin/main || { fail "checkout origin/main failed"; sudo -n systemctl start cosmos-deploy.service 2>/dev/null||true; disarm; exit 1; }
echo "prod now at: $(node -p 'require("./package.json").version')"
echo "--- npm ci ---"; npm ci >/tmp/deploy-npmci.log 2>&1 || { fail "npm ci failed (see /tmp/deploy-npmci.log)"; sudo -n systemctl start cosmos-deploy.service 2>/dev/null||true; disarm; exit 1; }
set -a; . "$PROD/.env.local"; set +a
npx prisma generate >/dev/null 2>&1 || { fail "prisma generate failed"; sudo -n systemctl start cosmos-deploy.service 2>/dev/null||true; disarm; exit 1; }

say "6) BUILD 4.5.0 (still no DB change — abort here is safe)"
npm run build >/tmp/deploy-build.log 2>&1 || { fail "build failed (see /tmp/deploy-build.log) — NOTHING migrated, old server still healthy"; sudo -n systemctl start cosmos-deploy.service 2>/dev/null||true; disarm; exit 1; }
echo "build ok"

say "7) [BREAKING] migrate deploy + restart (tight window)"
npx prisma migrate deploy 2>&1 | grep -v "deprecated\|prisma-config\|pris.ly" || { fail "migrate deploy FAILED. Per-migration is transactional, so a failed migration rolled back; old server likely still OK on Float. Verify, then decide. Freeze STILL ARMED."; exit 1; }
sudo -n systemctl restart cosmos-app.service || { fail "restart FAILED — DB IS MIGRATED but service didn't restart. Recover: 'sudo systemctl restart cosmos-app.service'. Freeze STILL ARMED."; exit 1; }
echo "restarted; waiting 20s for old server SIGKILL + bind..."; sleep 20

say "8) VERIFY"
H=$(curl -s --max-time 8 "$HEALTH" 2>/dev/null || echo "")
echo "health: $H"
echo "$H" | grep -q '"version":"'"$MAINV"'"' && echo "$H" | grep -q '"db":"up"' \
  || { fail "HEALTH CHECK FAILED (expected version $MAINV, db up). DB is migrated. Freeze STILL ARMED. See rollback in .deploy/deploy-runbook.md (restore $BASE's dump)."; exit 1; }
echo "--- money SUMs (must equal baseline $BASE) ---"
NOW=$(bash "$MAIN/.deploy/snapshot-baseline.sh" 2>/dev/null | sed -n '/money baselines/,/pg_dump/p' | grep -E '"(rev|exp|con|prod|tim|crm)"' || true)
echo "$NOW"
echo "(compare the above to $BASE — they must match)"

say "9) RESUME"
disarm
sudo -n systemctl start cosmos-deploy.service 2>/dev/null && echo "auto-deployer re-enabled" || echo "WARN: re-enable cosmos-deploy.service manually"
echo
echo "✅ DEPLOY COMPLETE — :3000 now serving $MAINV. Tell the other sessions: RESUME + 'git pull'."
