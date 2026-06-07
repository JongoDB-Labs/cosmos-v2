#!/usr/bin/env bash
# scripts/cutover/acceptance/run-parity-acceptance.sh
#
# SYNTHETIC Docker acceptance for the §9.2 cutover schema-parity + provenance HARD gate
# (scripts/cutover/parity-gate.mjs). NO PRODUCTION — two throwaway Postgres only:
#
#   BUILDER (:$BUILD_PORT)  — a v2-shaped DB: create roles, `prisma migrate deploy` ALL
#                             v2 migrations, then `pg_dump --schema-only` it. That dump is
#                             the MATCHING "prod" dump (parity by construction).
#   SCRATCH (:$SCRATCH_PORT) — the throwaway the gate restores each dump into (reset
#                             between runs).
#   SHADOW  (:$SHADOW_PORT)  — the throwaway Prisma resets + replays prisma/migrations into
#                             to build v2's REFERENCE schema for the DB-to-DB diff.
#
# Proves end-to-end:
#   (a) PASS  — gate against the matching dump: migrate diff EMPTY + classification FK
#               present + provenance written (with the migration-history hash).
#   (b) FAIL  — drift A: drop the data_classifications.project_id FK from a copy of the dump
#               => gate FAILS part 2 (classification FK missing), exit non-zero.
#   (c) FAIL  — drift B: drop a (non-audit) table from a copy of the dump
#               => gate FAILS part 1 (migrate diff non-empty, diff captured), exit non-zero.
#
# Requires sudo docker. Uses pgvector/pgvector:pg16 (the schema needs vector + pgcrypto).
# Tears everything down on exit. Run from the repo root.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

BUILD_PORT=55450
SCRATCH_PORT=55451
SHADOW_PORT=55452
BUILD_NAME=parity-acc-build
SCRATCH_NAME=parity-acc-scratch
SHADOW_NAME=parity-acc-shadow
PG_IMAGE=pgvector/pgvector:pg16
WORKDIR="$(mktemp -d /tmp/parity-acc.XXXXXX)"
STAMP="2026-06-07T00:00:00Z"
PROD_COMMIT="deadbeefcafe0000000000000000000000000000"

BUILD_URL="postgres://cosmos:cosmos@localhost:${BUILD_PORT}/cosmos"
SCRATCH_URL="postgres://cosmos:cosmos@localhost:${SCRATCH_PORT}/cosmos"
SHADOW_URL="postgres://cosmos:cosmos@localhost:${SHADOW_PORT}/cosmos"

D="sudo docker"
PASS=0
FAIL=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }

cleanup() {
  echo ""
  echo "── teardown ──"
  $D rm -f "$BUILD_NAME" "$SCRATCH_NAME" "$SHADOW_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR" || true
}
trap cleanup EXIT

start_pg() {
  local name="$1" port="$2"
  $D rm -f "$name" >/dev/null 2>&1 || true
  $D run -d --name "$name" \
    -e POSTGRES_USER=cosmos -e POSTGRES_PASSWORD=cosmos -e POSTGRES_DB=cosmos \
    -p "${port}:5432" "$PG_IMAGE" >/dev/null
  for i in $(seq 1 60); do
    $D exec "$name" pg_isready -U cosmos -d cosmos >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "start_pg: $name did not become ready"; exit 1
}

# Create the cosmos_app role the migrations + the dump's GRANTs reference.
make_app_role() {
  local name="$1"
  $D exec "$name" psql -v ON_ERROR_STOP=1 -U cosmos -d cosmos -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='cosmos_app') THEN CREATE ROLE cosmos_app LOGIN PASSWORD 'cosmos_app'; END IF; END \$\$;" >/dev/null
}

# Reset the scratch DB's public schema so each gate run restores into a clean slate.
# (client_min_messages=warning silences the large DROP SCHEMA CASCADE NOTICE list.)
reset_scratch() {
  $D exec "$SCRATCH_NAME" psql -v ON_ERROR_STOP=1 -U cosmos -d cosmos -c \
    "SET client_min_messages = warning; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO cosmos; GRANT USAGE ON SCHEMA public TO cosmos_app;" >/dev/null 2>&1
}

echo "── booting three throwaway Postgres (builder :$BUILD_PORT, scratch :$SCRATCH_PORT, shadow :$SHADOW_PORT) ──"
start_pg "$BUILD_NAME" "$BUILD_PORT"
start_pg "$SCRATCH_NAME" "$SCRATCH_PORT"
start_pg "$SHADOW_NAME" "$SHADOW_PORT"
make_app_role "$BUILD_NAME"
make_app_role "$SCRATCH_NAME"
# The shadow DB needs the cosmos_app role too — the migrations GRANT to it during replay.
make_app_role "$SHADOW_NAME"

echo "── applying ALL v2 migrations to the builder (prisma migrate deploy) ──"
DATABASE_URL="$BUILD_URL" DIRECT_URL="$BUILD_URL" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/build-migrate.err" \
  || { echo "builder migrate failed:"; cat "$WORKDIR/build-migrate.err"; exit 1; }
echo "    migrations applied."

# Sanity: the new classification FK migration must actually be present in the builder.
FK_IN_BUILD="$($D exec "$BUILD_NAME" psql -U cosmos -d cosmos -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname='data_classifications_project_id_fkey'")"
[ "$FK_IN_BUILD" = "1" ] \
  && ok "builder carries data_classifications_project_id_fkey (reconciled baseline)" \
  || bad "builder MISSING the classification FK (migration 20260606140000 not applied?)"

echo "── pg_dump --schema-only the builder => the MATCHING prod dump ──"
$D exec "$BUILD_NAME" pg_dump --schema-only -U cosmos -d cosmos > "$WORKDIR/prod-schema.sql"
[ -s "$WORKDIR/prod-schema.sql" ] && ok "matching prod dump captured ($(wc -l < "$WORKDIR/prod-schema.sql") lines)" || bad "prod dump empty"

echo "── export the builder's _prisma_migrations history (for provenance) ──"
$D exec "$BUILD_NAME" psql -U cosmos -d cosmos --csv -c \
  "SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name" \
  > "$WORKDIR/prod-migrations.csv"
MIG_N=$(( $(wc -l < "$WORKDIR/prod-migrations.csv") - 1 ))
[ "$MIG_N" -ge 30 ] && ok "prod migrations history exported ($MIG_N migrations)" || bad "migration history too short ($MIG_N)"

# ════════════════════════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════ (a) PASS — gate against the MATCHING dump ════════════════════"
reset_scratch
set +e
npx tsx scripts/cutover/parity-gate.mjs \
  --prod-schema-dump "$WORKDIR/prod-schema.sql" \
  --prod-migrations  "$WORKDIR/prod-migrations.csv" \
  --prod-commit      "$PROD_COMMIT" \
  --scratch-url      "$SCRATCH_URL" \
  --shadow-url       "$SHADOW_URL" \
  --stamp            "$STAMP" \
  --out              "$WORKDIR/baseline-pass.json"
GATE_RC=$?
set -e
[ "$GATE_RC" -eq 0 ] && ok "gate EXIT 0 on the matching dump (PASS)" || bad "gate did NOT pass on the matching dump (exit $GATE_RC)"
if [ -f "$WORKDIR/baseline-pass.json" ]; then
  ok "provenance file written"
  node -e '
    const r = require("'"$WORKDIR"'/baseline-pass.json");
    const fail=(m)=>{console.error("ASSERT-FAIL "+m);process.exitCode=3;};
    if (r.parityGate!=="pass") fail("parityGate not pass: "+r.parityGate);
    if (r.classificationFk!==true) fail("classificationFk not true");
    if (!/^[0-9a-f]{64}$/.test(r.migrationHistoryHash||"")) fail("migrationHistoryHash not a sha256: "+r.migrationHistoryHash);
    if (r.migrationCount<30) fail("migrationCount too low: "+r.migrationCount);
    if (r.prodCommit!=="'"$PROD_COMMIT"'") fail("prodCommit mismatch: "+r.prodCommit);
    if (r.checkedAt!=="'"$STAMP"'") fail("checkedAt mismatch: "+r.checkedAt);
    console.log("    provenance: parityGate="+r.parityGate+" classificationFk="+r.classificationFk+" migrationCount="+r.migrationCount+" hash="+r.migrationHistoryHash.slice(0,16)+"… commit="+r.prodCommit.slice(0,12));
  ' && ok "provenance asserts (parityGate=pass, FK=true, sha256 history hash, count, commit, stamp)" || bad "provenance assertions failed"
else
  bad "provenance file NOT written on PASS"
fi

# ════════════════════════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════ (b) FAIL — drift A: drop the classification FK ════════════════════"
# Copy the matching dump and APPEND a trailing DROP CONSTRAINT so the restored snapshot is
# missing ONLY the data_classifications.project_id FK (robust vs pg_dump's multi-line FK
# emission — the dump restores in full, then the trailing ALTER removes the one constraint).
cp "$WORKDIR/prod-schema.sql" "$WORKDIR/drift-a.sql"
printf '\n-- SYNTHETIC DRIFT A: drop ONLY the classification FK post-restore.\nALTER TABLE "public"."data_classifications" DROP CONSTRAINT IF EXISTS "data_classifications_project_id_fkey";\n' >> "$WORKDIR/drift-a.sql"
ok "drift A copy appends DROP CONSTRAINT data_classifications_project_id_fkey"
reset_scratch
set +e
npx tsx scripts/cutover/parity-gate.mjs \
  --prod-schema-dump "$WORKDIR/drift-a.sql" \
  --prod-migrations  "$WORKDIR/prod-migrations.csv" \
  --prod-commit      "$PROD_COMMIT" \
  --scratch-url      "$SCRATCH_URL" \
  --shadow-url       "$SHADOW_URL" \
  --stamp            "$STAMP" \
  --out              "$WORKDIR/baseline-drift-a.json"
GATE_A_RC=$?
set -e
[ "$GATE_A_RC" -ne 0 ] && ok "gate EXIT non-zero on drift A (exit $GATE_A_RC)" || bad "gate WRONGLY passed drift A"
node -e '
  const r = require("'"$WORKDIR"'/baseline-drift-a.json");
  const fail=(m)=>{console.error("ASSERT-FAIL "+m);process.exitCode=3;};
  if (r.classificationFk!==false) fail("classificationFk should be false on drift A: "+r.classificationFk);
  if (r.parityGate!=="fail") fail("parityGate should be fail: "+r.parityGate);
  console.log("    drift A provenance: classificationFk="+r.classificationFk+" parityGate="+r.parityGate);
' && ok "drift A: provenance records classificationFk=false, parityGate=fail (part 2 failed)" || bad "drift A provenance assertions failed"

# ════════════════════════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════ (c) FAIL — drift B: drop a table (migrate diff non-empty) ════════════════════"
# Build a copy that, ONCE RESTORED, is missing the home_widgets table (a non-audit table).
# The helper appends a trailing `DROP TABLE ... CASCADE` so the dump restores in full and
# then the table is removed — robust vs the dump's multi-line, dependency-tangled DDL. The
# restored snapshot is therefore structurally SHORT one table vs v2's migrations.
node "$REPO/scripts/cutover/acceptance/drop-table-from-dump.mjs" \
  --in "$WORKDIR/prod-schema.sql" --out "$WORKDIR/drift-b.sql" --table home_widgets
if grep -qE 'DROP TABLE IF EXISTS "public"."home_widgets" CASCADE' "$WORKDIR/drift-b.sql"; then ok "drift B copy appends DROP TABLE home_widgets CASCADE (table removed post-restore)"; else bad "drift B copy missing the trailing DROP TABLE"; fi
reset_scratch
set +e
DIFF_LOG="$WORKDIR/gate-drift-b.log"
npx tsx scripts/cutover/parity-gate.mjs \
  --prod-schema-dump "$WORKDIR/drift-b.sql" \
  --prod-migrations  "$WORKDIR/prod-migrations.csv" \
  --prod-commit      "$PROD_COMMIT" \
  --scratch-url      "$SCRATCH_URL" \
  --shadow-url       "$SHADOW_URL" \
  --stamp            "$STAMP" \
  --out              "$WORKDIR/baseline-drift-b.json" 2>&1 | tee "$DIFF_LOG"
GATE_B_RC=${PIPESTATUS[0]}
set -e
[ "$GATE_B_RC" -ne 0 ] && ok "gate EXIT non-zero on drift B (exit $GATE_B_RC)" || bad "gate WRONGLY passed drift B"
grep -q "migrate diff is NON-EMPTY" "$DIFF_LOG" && ok "drift B: gate reports migrate diff NON-EMPTY (part 1 failed)" || bad "drift B: gate did not report a non-empty diff"
grep -qi "home_widgets" "$DIFF_LOG" && ok "drift B: captured diff names the missing table (home_widgets)" || bad "drift B: diff did not name home_widgets"
node -e '
  const r = require("'"$WORKDIR"'/baseline-drift-b.json");
  const fail=(m)=>{console.error("ASSERT-FAIL "+m);process.exitCode=3;};
  if (r.parityGate!=="fail") fail("parityGate should be fail on drift B: "+r.parityGate);
  console.log("    drift B provenance: parityGate="+r.parityGate+" classificationFk="+r.classificationFk);
' && ok "drift B: provenance records parityGate=fail" || bad "drift B provenance assertions failed"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "PARITY ACCEPTANCE RESULT: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
