#!/usr/bin/env bash
# scripts/cutover/acceptance/run-acceptance.sh
#
# DOCKER ACCEPTANCE for the per-tenant cutover engine — SYNTHETIC ORG, two throwaway
# Postgres, NO production. Proves end-to-end:
#   - export → import → verify  (counts match, per-row money equal, duplicate classification
#     deduped to the highest rank + logged, CUI marking preserved, verify CLEAN / exit 0)
#   - import re-run is idempotent (0 inserted / 0 updated)
#   - NEGATIVE: corrupt a target money row → verify exits non-zero
#   - mutable update: bump a source row's updated_at + re-import → it updates
#   - org-scoping: the OTHER org's rows are never exported/imported/verified
#   - freeze: the proxy predicate returns 405 on a write / passes a read
#
# Requires sudo docker. Uses pgvector/pgvector:pg16 (the schema needs the vector extension).
# Tears everything down on exit. Run from the repo root.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

SRC_PORT=55440
TGT_PORT=55441
SRC_NAME=cutover-acc-src
TGT_NAME=cutover-acc-tgt
PG_IMAGE=pgvector/pgvector:pg16
WORKDIR="$(mktemp -d /tmp/cutover-acc.XXXXXX)"
EXPORT_DIR="$WORKDIR/export"
TENANT="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
STAMP="2026-06-06T00:00:00Z"

SRC_OWNER="postgres://cosmos:cosmos@localhost:${SRC_PORT}/cosmos"
TGT_OWNER="postgres://cosmos:cosmos@localhost:${TGT_PORT}/cosmos"

D="sudo docker"
PASS=0
FAIL=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1"; FAIL=$((FAIL+1)); }

cleanup() {
  echo ""
  echo "── teardown ──"
  $D rm -f "$SRC_NAME" "$TGT_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR" || true
}
trap cleanup EXIT

start_pg() {
  local name="$1" port="$2"
  $D rm -f "$name" >/dev/null 2>&1 || true
  # POSTGRES_USER=cosmos makes the owner role match the migrations' ALTER DEFAULT PRIVILEGES.
  $D run -d --name "$name" \
    -e POSTGRES_USER=cosmos -e POSTGRES_PASSWORD=cosmos -e POSTGRES_DB=cosmos \
    -p "${port}:5432" "$PG_IMAGE" >/dev/null
  for i in $(seq 1 60); do
    $D exec "$name" pg_isready -U cosmos -d cosmos >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "start_pg: $name did not become ready"; exit 1
}

prepare_db() {
  local name="$1"
  # Create the least-privilege app role the migrations GRANT to (mirrors compose init).
  $D exec "$name" psql -v ON_ERROR_STOP=1 -U cosmos -d cosmos -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='cosmos_app') THEN CREATE ROLE cosmos_app LOGIN PASSWORD 'cosmos_app'; END IF; END \$\$;" >/dev/null
}

echo "── booting two throwaway Postgres (source :$SRC_PORT, target :$TGT_PORT) ──"
start_pg "$SRC_NAME" "$SRC_PORT"
start_pg "$TGT_NAME" "$TGT_PORT"
prepare_db "$SRC_NAME"
prepare_db "$TGT_NAME"

echo "── applying v2 migrations to both (prisma migrate deploy) ──"
DATABASE_URL="$SRC_OWNER" DIRECT_URL="$SRC_OWNER" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/src-migrate.err" \
  || { echo "source migrate failed:"; cat "$WORKDIR/src-migrate.err"; exit 1; }
DATABASE_URL="$TGT_OWNER" DIRECT_URL="$TGT_OWNER" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/tgt-migrate.err" \
  || { echo "target migrate failed:"; cat "$WORKDIR/tgt-migrate.err"; exit 1; }
echo "    migrations applied."

echo "── seeding the synthetic org into the SOURCE ──"
SEED_URL="$SRC_OWNER" node scripts/cutover/acceptance/seed-synthetic.mjs

echo ""
echo "════════════════════ 1. EXPORT ════════════════════"
npx tsx scripts/cutover/export-org.mjs --source "$SRC_OWNER" --org "$TENANT" --out "$EXPORT_DIR" --stamp "$STAMP"
[ -f "$EXPORT_DIR/manifest.json" ] && ok "export manifest written" || bad "export manifest missing"
# org-scope: the OTHER org's work item must NOT appear in the export
if grep -rq "OTHER ORG SECRET" "$EXPORT_DIR/"; then bad "org-scope: other org data leaked into export"; else ok "org-scope: other org data NOT in export"; fi
# org-scope: the OTHER org's user (Carol) must NOT be pulled by closure (only TENANT's refs)
if grep -rq "carol@other.test" "$EXPORT_DIR/"; then bad "org-scope: other org USER leaked via closure"; else ok "org-scope: other org user NOT in export (closure stays org-bounded)"; fi
# C1 closure: the GLOBAL work_item_type (org_id NULL) referenced by a migrated work_item is carried
GWIT="44444444-0000-0000-0000-0000000000e0"
grep -q "$GWIT" "$EXPORT_DIR/tables/work_item_types.ndjson" && ok "C1 closure: GLOBAL work_item_type carried into export" || bad "C1 closure: global work_item_type MISSING from export"
# C2 closure: the GHOST non-member user (referenced by home_widget owner_id + assignee_id) is carried
UGHOST="11111111-0000-0000-0000-0000000000e0"
grep -q "$UGHOST" "$EXPORT_DIR/tables/users.ndjson" && ok "C2 closure: non-member (ghost) user carried into export" || bad "C2 closure: ghost user MISSING from export"
# manifest records a non-zero closure-row total
CLOSURE_N="$(node -e 'console.log(require("'"$EXPORT_DIR"'/manifest.json").closureRows)')"
[ "$CLOSURE_N" -ge 2 ] && ok "manifest reports referential-closure rows (closureRows=$CLOSURE_N)" || bad "manifest closureRows too low: $CLOSURE_N"
# C3: the CustomField array-jsonb options are exported as a JSON array (not a PG array literal)
grep -q '"options":\["High","Medium","Low"\]' "$EXPORT_DIR/tables/custom_fields.ndjson" && ok "C3: CustomField.options exported as a JSON array" || bad "C3: CustomField.options not a JSON array in export"

echo ""
echo "════════════════════ 2. IMPORT (first run) ════════════════════"
IMPORT1="$(npx tsx scripts/cutover/import-org.mjs --target "$TGT_OWNER" --in "$EXPORT_DIR" --org "$TENANT")"
echo "$IMPORT1"
echo "$IMPORT1" | grep -q '"droppedLevel": "FOUO"' && ok "DataClassification dedupe dropped the FOUO duplicate ceiling (logged)" || bad "dedupe drop not logged"
echo "$IMPORT1" | grep -q '"keptLevel": "CUI"' && ok "DataClassification dedupe KEPT the CUI ceiling (highest rank)" || bad "dedupe kept wrong level"

echo ""
echo "════════════════════ 3. VERIFY (the hard flip gate) ════════════════════"
if npx tsx scripts/cutover/verify-org.mjs --source "$SRC_OWNER" --target "$TGT_OWNER" --org "$TENANT" --out "$WORKDIR/verify1.json"; then
  ok "verify CLEAN (exit 0) — counts + per-row money + markings + checksums"
else
  bad "verify FAILED on a clean import (should have been clean)"
  cat "$WORKDIR/verify1.json"
fi
# explicit assertions from the report
node -e '
  const r = require("'"$WORKDIR"'/verify1.json");
  const fail = (m)=>{console.error("ASSERT-FAIL "+m);process.exitCode=3;};
  if (!r.clean) fail("report not clean");
  if (!r.markings || !r.markings.ok || r.markings.source!==1 || r.markings.target!==1) fail("CUI/FOUO marking invariant: "+JSON.stringify(r.markings));
  const money = r.money.filter(m=>!m.ok); if (money.length) fail("money mismatches: "+JSON.stringify(money));
  const counts = r.counts.filter(c=>!c.ok); if (counts.length) fail("count mismatches: "+JSON.stringify(counts));
  const dc = r.counts.find(c=>c.table==="data_classifications");
  if (!dc || dc.source!==3 || dc.target!==2 || dc.expectedTarget!==2) fail("data_classifications count (src 3 -> deduped 2): "+JSON.stringify(dc));
  // referential probe must be present, have checked FKs, and find ZERO orphans on a clean import
  if (!r.referential || !r.referential.ok || r.referential.orphans!==0 || !(r.referential.checked>0)) fail("referential probe not clean: "+JSON.stringify(r.referential));
  console.log("    verify report: clean="+r.clean+", markings(src/tgt)="+r.markings.source+"/"+r.markings.target+", data_classifications src="+dc.source+" tgt="+dc.target+", referential checked="+r.referential.checked+" orphans="+r.referential.orphans);
' && ok "verify report assertions (markings preserved, money OK, counts OK, dedupe 3->2, referential probe 0 orphans)" || bad "verify report assertions"

# C1: the global work_item_type FK resolves in the target (closure carried the parent → no dangling FK)
GWIT_IN_TGT="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT count(*) FROM work_items wi JOIN work_item_types t ON wi.work_item_type_id=t.id WHERE t.id='$GWIT' AND t.org_id IS NULL")"
[ "$GWIT_IN_TGT" = "1" ] && ok "C1: migrated work_item resolves its GLOBAL work_item_type FK in target" || bad "C1: global work_item_type FK does not resolve in target ($GWIT_IN_TGT)"
# C2: the ghost user landed in the target (closure) and the home_widget + assignee resolve
GHOST_IN_TGT="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT count(*) FROM users WHERE id='$UGHOST'")"
[ "$GHOST_IN_TGT" = "1" ] && ok "C2: ghost (non-member) user carried into target by closure" || bad "C2: ghost user missing from target ($GHOST_IN_TGT)"
HW_RESOLVES="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT count(*) FROM home_widgets hw JOIN users u ON hw.owner_id=u.id WHERE hw.org_id='$TENANT'")"
[ "$HW_RESOLVES" = "1" ] && ok "C2: home_widgets.owner_id (HARD FK) resolves in target" || bad "C2: home_widget owner_id dangling in target ($HW_RESOLVES)"
# C3: CustomField.options array-jsonb imported WITHOUT abort and round-trips exactly
CF_OPTS="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT options::text FROM custom_fields WHERE id='e1e1e1e1-0000-0000-0000-000000000001'")"
[ "$CF_OPTS" = '["High", "Medium", "Low"]' ] && ok "C3: array-jsonb CustomField.options imported + round-tripped exactly ($CF_OPTS)" || bad "C3: CustomField.options wrong in target: '$CF_OPTS'"

# CUI marking actually present in target (verbatim)
CUI_IN_TGT="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT array_to_string(markings,',') FROM data_classifications WHERE org_id='$TENANT' AND project_id IS NULL")"
[ "$CUI_IN_TGT" = "CUI//SP-PRVCY" ] && ok "CUI marking carried VERBATIM into target ($CUI_IN_TGT)" || bad "CUI marking wrong in target: '$CUI_IN_TGT'"
# org-scope: the OTHER org's row must NOT be in the target
OTHER_IN_TGT="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT count(*) FROM work_items WHERE title='OTHER ORG SECRET'")"
[ "$OTHER_IN_TGT" = "0" ] && ok "org-scope: other org row NOT imported into target" || bad "org-scope: other org row leaked into target"

echo ""
echo "════════════════════ 4. IMPORT (re-run = idempotent) ════════════════════"
IMPORT2="$(npx tsx scripts/cutover/import-org.mjs --target "$TGT_OWNER" --in "$EXPORT_DIR" --org "$TENANT")"
TOT2="$(echo "$IMPORT2" | grep '^CUTOVER_IMPORT_TOTALS ' | sed 's/^CUTOVER_IMPORT_TOTALS //')"
INS2="$(echo "$TOT2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.inserted+" "+j.updated)})')"
[ "$INS2" = "0 0" ] && ok "idempotent re-run: 0 inserted / 0 updated" || bad "re-run not idempotent: inserted/updated = $INS2"

echo ""
echo "════════════════════ 5. NEGATIVE: corrupt a target money row → verify FAILS ════════════════════"
$D exec "$TGT_NAME" psql -U cosmos -d cosmos -c "UPDATE revenues SET amount='15000.7600' WHERE id='a1a1a1a1-0000-0000-0000-000000000001'" >/dev/null
if npx tsx scripts/cutover/verify-org.mjs --source "$SRC_OWNER" --target "$TGT_OWNER" --org "$TENANT" --out "$WORKDIR/verify2.json" >/dev/null 2>&1; then
  bad "verify did NOT detect the corrupted money row (should exit non-zero)"
else
  ok "verify DETECTED the corrupted money row (exit non-zero) — the gate works"
fi
grep -q "15000.7600" "$WORKDIR/verify2.json" && ok "verify report names the corrupted value" || bad "verify report missing the bad value"
# restore the corrupted value so later steps are clean
$D exec "$TGT_NAME" psql -U cosmos -d cosmos -c "UPDATE revenues SET amount='15000.7500' WHERE id='a1a1a1a1-0000-0000-0000-000000000001'" >/dev/null

echo ""
echo "════════════════════ 5b. NEGATIVE: dangling FK → referential probe FAILS (the gate gates) ════════════════════"
# Simulate a referentially-incomplete import: delete the GLOBAL work_item_type parent while
# suppressing FK triggers (exactly the silent-dangling-FK condition the import runs under).
# work_items.work_item_type_id is RESTRICT, so this leaves a real DANGLING FK in the target.
$D exec "$TGT_NAME" psql -U cosmos -d cosmos -c "BEGIN; SET session_replication_role=replica; DELETE FROM work_item_types WHERE id='$GWIT'; COMMIT;" >/dev/null
if npx tsx scripts/cutover/verify-org.mjs --source "$SRC_OWNER" --target "$TGT_OWNER" --org "$TENANT" --out "$WORKDIR/verify_orphan.json" >/dev/null 2>&1; then
  bad "referential probe did NOT detect the dangling FK (should exit non-zero)"
else
  ok "referential probe DETECTED the dangling FK (exit non-zero) — the gate catches C1/C2"
fi
# the report must NAME the offending table.column
node -e '
  const r = require("'"$WORKDIR"'/verify_orphan.json");
  const fail=(m)=>{console.error("ASSERT-FAIL "+m);process.exitCode=3;};
  if (r.clean) fail("report wrongly clean with a dangling FK");
  if (!r.referential || r.referential.ok || r.referential.orphans<1) fail("referential.orphans not flagged: "+JSON.stringify(r.referential));
  const named = (r.referential.details||[]).some(d=>d.includes("work_items.work_item_type_id"));
  if (!named) fail("report does not name work_items.work_item_type_id: "+JSON.stringify(r.referential.details));
  console.log("    orphan probe: orphans="+r.referential.orphans+", first="+(r.referential.details||[])[0]);
' && ok "referential report NAMES the offending table.column (work_items.work_item_type_id)" || bad "referential report did not name the offending FK"
# also prove the IN-TRANSACTION probe rolls a re-import back rather than committing a dangling FK:
# re-import from the (intact) export should re-insert the missing global parent → probe clean again.
npx tsx scripts/cutover/import-org.mjs --target "$TGT_OWNER" --in "$EXPORT_DIR" --org "$TENANT" >/dev/null 2>&1
REPAIRED="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT count(*) FROM work_item_types WHERE id='$GWIT'")"
[ "$REPAIRED" = "1" ] && ok "re-import restored the closure parent (idempotent replay heals the gap)" || bad "re-import did not restore the closure parent ($REPAIRED)"

echo ""
echo "════════════════════ 6. MUTABLE UPDATE: bump source row → re-import updates ════════════════════"
$D exec "$SRC_NAME" psql -U cosmos -d cosmos -c "UPDATE work_items SET title='Build the thing v2', updated_at='2026-06-07T00:00:00Z' WHERE id='66666666-0000-0000-0000-000000000001'" >/dev/null
npx tsx scripts/cutover/export-org.mjs --source "$SRC_OWNER" --org "$TENANT" --out "$EXPORT_DIR" --stamp "$STAMP" >/dev/null
IMPORT3="$(npx tsx scripts/cutover/import-org.mjs --target "$TGT_OWNER" --in "$EXPORT_DIR" --org "$TENANT")"
TOT3="$(echo "$IMPORT3" | grep '^CUTOVER_IMPORT_TOTALS ' | sed 's/^CUTOVER_IMPORT_TOTALS //')"
UPD3="$(echo "$TOT3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.updated)})')"
NEW_TITLE="$($D exec "$TGT_NAME" psql -U cosmos -d cosmos -tAc "SELECT title FROM work_items WHERE id='66666666-0000-0000-0000-000000000001'")"
{ [ "$UPD3" -ge 1 ] && [ "$NEW_TITLE" = "Build the thing v2" ]; } && ok "mutable row updated on re-import (updated=$UPD3, title='$NEW_TITLE')" || bad "mutable update failed (updated=$UPD3, title='$NEW_TITLE')"

echo ""
echo "════════════════════ 7. FREEZE: proxy returns 405 on write, passes read ════════════════════"
# Freeze the tenant by inserting into frozen_orgs on the TARGET, then exercise the proxy
# predicate directly (the proxy reads frozen_orgs via prisma).
$D exec "$TGT_NAME" psql -U cosmos -d cosmos -c "INSERT INTO frozen_orgs (org_id, org_slug, reason) VALUES ('$TENANT','tenant','acceptance') ON CONFLICT (org_id) DO NOTHING" >/dev/null
FREEZE_OUT="$(DATABASE_URL="$TGT_OWNER" TENANT_ID="$TENANT" npx tsx scripts/cutover/acceptance/freeze-probe.mts)"
echo "$FREEZE_OUT"
echo "$FREEZE_OUT" | grep -q "POST /api/v1/orgs/<id> -> 405" && ok "frozen org: POST mutating verb -> 405" || bad "frozen org POST not 405"
echo "$FREEZE_OUT" | grep -q "GET  /api/v1/orgs/<id> -> PASS" && ok "frozen org: GET read -> passes" || bad "frozen org GET did not pass"
echo "$FREEZE_OUT" | grep -q "POST /tenant (slug) -> 405" && ok "frozen org (by slug): POST -> 405" || bad "frozen org slug POST not 405"
echo "$FREEZE_OUT" | grep -q "unfrozen -> PASS" && ok "after unfreeze: POST passes again" || bad "unfreeze did not restore writes"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "ACCEPTANCE RESULT: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
