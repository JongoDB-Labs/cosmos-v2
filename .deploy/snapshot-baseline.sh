#!/usr/bin/env bash
# Capture a pre-deploy baseline: money SUMs (to verify data is unchanged after the
# breaking Float->Decimal migration) + a full pg_dump (the rollback safety net).
# Run from the repo root. Loads prod DB creds from .env.local.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env.local; set +a

TS="$(date -u +%Y%m%d-%H%M%S)"
OUT=".deploy/backups"
mkdir -p "$OUT"

echo "=== money baselines @ $TS (UTC) ==="
node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const n = (a) => (a._sum && Object.values(a._sum)[0]) ?? 0;
  const [rev, exp, con, prod, tim, crm] = await Promise.all([
    p.revenue.aggregate({ _sum: { amount: true } }),
    p.expense.aggregate({ _sum: { amount: true } }),
    p.contract.aggregate({ _sum: { value: true } }),
    p.product.aggregate({ _sum: { price: true } }),
    p.timeEntry.aggregate({ _sum: { rate: true } }),
    p.crmContact.aggregate({ _sum: { dealValue: true } }),
  ]);
  console.log(JSON.stringify({ rev: String(n(rev)), exp: String(n(exp)), con: String(n(con)), prod: String(n(prod)), tim: String(n(tim)), crm: String(n(crm)) }, null, 2));
  await p.$disconnect();
})().catch((e) => { console.error("baseline ERROR:", e.message); process.exit(1); });
' | tee "$OUT/money-baseline-$TS.json"

echo ""
echo "=== pg_dump -> $OUT/cosmos-$TS.sql.gz (rollback safety net) ==="
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" 2>/dev/null | gzip > "$OUT/cosmos-$TS.sql.gz" \
    && echo "dump OK: $(du -h "$OUT/cosmos-$TS.sql.gz" | cut -f1)" \
    || echo "dump FAILED — do NOT deploy without a rollback dump."
else
  echo "pg_dump NOT FOUND — install it or take a DB snapshot another way BEFORE deploying."
fi
echo ""
echo "Compare these SUMs again AFTER deploy; they must be byte-identical (Float->Decimal must not change values)."
