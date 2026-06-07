#!/usr/bin/env bash
# scripts/cutover/acceptance/run-soak-reconcile-acceptance.sh
#
# DOCKER ACCEPTANCE for the INCREMENTAL SOAK-SYNC + FINAL RECONCILE — SYNTHETIC org, two
# throwaway Postgres, NO production. Proves the near-zero-downtime cutover catch-up:
#
#   1. full first soak-sync (delta with no state = full seed) -> verify CLEAN
#   2. MUTATE the SOURCE: INSERT new rows, UPDATE existing (bump updated_at), DELETE some
#      mutable rows (a work_item + a note)
#   3. soak-sync (delta) -> the INSERTS + UPDATES propagate, but the DELETES do NOT yet
#      (the deleted rows LINGER in the target — a watermark delta can't see a delete) ->
#      verify FAILS on the count mismatch (proves the lingering)
#   4. reconcile-org (the under-freeze final) -> the deleted rows are now removed -> verify
#      CLEAN with EXACT counts (deletes applied exactly)
#   5. PROVE the invariants:
#        - the SHARED closure parent (global work_item_type org_id NULL + the two-org user Dave)
#          is NOT deleted by the reconcile
#        - the OTHER org's rows are untouched
#        - the orphan probe stays clean
#        - a deliberately-orphaning delete is caught/failed (negative test)
#   6. tear down
#
# Requires sudo docker + pgvector/pgvector:pg16. FREE ports 55450/55451 (the v2.11 acceptance
# uses 55440/55441; many host ports are taken). Tears everything down on exit.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

SRC_PORT=55450
TGT_PORT=55451
SRC_NAME=soak-acc-src
TGT_NAME=soak-acc-tgt
PG_IMAGE=pgvector/pgvector:pg16
WORKDIR="$(mktemp -d /tmp/soak-acc.XXXXXX)"
STATE="$WORKDIR/soak-state.json"
TENANT="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
OTHER="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
STAMP="2026-06-07T00:00:00Z"

SRC="postgres://cosmos:cosmos@localhost:${SRC_PORT}/cosmos"
TGT="postgres://cosmos:cosmos@localhost:${TGT_PORT}/cosmos"

# Known UUIDs from seed-synthetic.mjs
GWIT="44444444-0000-0000-0000-0000000000e0"   # GLOBAL work_item_type (org_id NULL) — closure parent
USHARED="11111111-0000-0000-0000-0000000000aa" # user in BOTH orgs — closure parent
WORKITEM="66666666-0000-0000-0000-000000000001" # mutable; we UPDATE this
WI_GLOBAL="66666666-0000-0000-0000-000000000002" # references the global WIT; we DELETE this (orphan-safe)
NOTE="77777777-0000-0000-0000-000000000001"     # mutable; we DELETE this
OTHER_WI="66666666-0000-0000-0000-0000000000ff"  # OTHER org's work_item — must stay untouched

D="sudo docker"
PASS=0
FAIL=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
psql_t() { $D exec "$1" psql -U cosmos -d cosmos -tAc "$2"; }

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
  $D exec "$1" psql -v ON_ERROR_STOP=1 -U cosmos -d cosmos -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='cosmos_app') THEN CREATE ROLE cosmos_app LOGIN PASSWORD 'cosmos_app'; END IF; END \$\$;" >/dev/null
}

echo "── booting two throwaway Postgres (source :$SRC_PORT, target :$TGT_PORT) ──"
start_pg "$SRC_NAME" "$SRC_PORT"
start_pg "$TGT_NAME" "$TGT_PORT"
prepare_db "$SRC_NAME"
prepare_db "$TGT_NAME"

echo "── applying v2 migrations to both ──"
DATABASE_URL="$SRC" DIRECT_URL="$SRC" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/src-migrate.err" \
  || { echo "source migrate failed:"; cat "$WORKDIR/src-migrate.err"; exit 1; }
DATABASE_URL="$TGT" DIRECT_URL="$TGT" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/tgt-migrate.err" \
  || { echo "target migrate failed:"; cat "$WORKDIR/tgt-migrate.err"; exit 1; }
echo "    migrations applied."

echo "── seeding the synthetic org into the SOURCE ──"
SEED_URL="$SRC" node scripts/cutover/acceptance/seed-synthetic.mjs

echo ""
echo "════════════════════ 1. FULL FIRST SOAK-SYNC (no state = full seed) ════════════════════"
SOAK1="$(npx tsx scripts/cutover/soak-sync.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --state "$STATE" --stamp "$STAMP")"
echo "$SOAK1" | tail -8
[ -f "$STATE" ] && ok "soak state file written" || bad "soak state file missing"
# state must record a watermark for a mutable table (work_items)
grep -q '"work_items"' "$STATE" && ok "state records a per-table watermark (work_items)" || bad "state missing work_items watermark"

echo ""
echo "──── verify after full first sync (must be CLEAN) ────"
if npx tsx scripts/cutover/verify-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --out "$WORKDIR/v1.json" >/dev/null 2>&1; then
  ok "verify CLEAN after full first soak-sync"
else
  bad "verify FAILED after full first soak-sync"; cat "$WORKDIR/v1.json"
fi
# baseline target counts for later exact-match assertions
WI_BEFORE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE org_id='$TENANT'")"
NOTE_BEFORE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM notes WHERE org_id='$TENANT'")"
echo "    target tenant counts after first sync: work_items=$WI_BEFORE notes=$NOTE_BEFORE"

echo ""
echo "════════════════════ 2. MUTATE THE SOURCE (insert / update / delete) ════════════════════"
# INSERT a new work_item (newer updated_at) + a new note.
psql_t "$SRC_NAME" "INSERT INTO work_items (id, org_id, project_id, title, column_key, ticket_number, work_item_type_id, created_by_id, created_at, updated_at) VALUES ('66666666-0000-0000-0000-0000000000a1','$TENANT','33333333-0000-0000-0000-000000000001','NEW soak item','todo',10,'44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','2026-06-07T01:00:00Z','2026-06-07T01:00:00Z')" >/dev/null
psql_t "$SRC_NAME" "INSERT INTO notes (id, org_id, author_id, title, content, created_at, updated_at) VALUES ('77777777-0000-0000-0000-0000000000a1','$TENANT','11111111-0000-0000-0000-000000000001','NEW note','fresh','2026-06-07T01:00:00Z','2026-06-07T01:00:00Z')" >/dev/null
# UPDATE an existing work_item (bump updated_at so the delta sees it).
psql_t "$SRC_NAME" "UPDATE work_items SET title='Build the thing (UPDATED)', updated_at='2026-06-07T02:00:00Z' WHERE id='$WORKITEM'" >/dev/null
# DELETE some mutable rows: the work_item that references the GLOBAL type + a note.
psql_t "$SRC_NAME" "DELETE FROM work_items WHERE id='$WI_GLOBAL'" >/dev/null
psql_t "$SRC_NAME" "DELETE FROM notes WHERE id='$NOTE'" >/dev/null
echo "    source mutated: +1 work_item, +1 note, ~1 work_item (updated), -1 work_item (global-ref), -1 note"
SRC_WI="$(psql_t "$SRC_NAME" "SELECT count(*) FROM work_items WHERE org_id='$TENANT'")"
SRC_NOTE="$(psql_t "$SRC_NAME" "SELECT count(*) FROM notes WHERE org_id='$TENANT'")"
echo "    source tenant counts now: work_items=$SRC_WI notes=$SRC_NOTE"

echo ""
echo "════════════════════ 3. SOAK-SYNC DELTA: inserts/updates propagate, DELETES do NOT ════════════════════"
SOAK2="$(npx tsx scripts/cutover/soak-sync.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --state "$STATE" --stamp "$STAMP")"
echo "$SOAK2" | grep -E 'SOAK_SYNC_CYCLE|work_items|notes' | tail -8
# the new insert propagated
NEWWI="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE id='66666666-0000-0000-0000-0000000000a1'")"
[ "$NEWWI" = "1" ] && ok "delta propagated the INSERTed work_item" || bad "delta did not propagate the insert ($NEWWI)"
NEWNOTE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM notes WHERE id='77777777-0000-0000-0000-0000000000a1'")"
[ "$NEWNOTE" = "1" ] && ok "delta propagated the INSERTed note" || bad "delta did not propagate the new note ($NEWNOTE)"
# the update propagated
UPTITLE="$(psql_t "$TGT_NAME" "SELECT title FROM work_items WHERE id='$WORKITEM'")"
[ "$UPTITLE" = "Build the thing (UPDATED)" ] && ok "delta propagated the UPDATE (title bumped)" || bad "delta did not propagate the update ('$UPTITLE')"
# the DELETES did NOT propagate — the rows still LINGER in the target
LINGER_WI="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE id='$WI_GLOBAL'")"
LINGER_NOTE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM notes WHERE id='$NOTE'")"
{ [ "$LINGER_WI" = "1" ] && [ "$LINGER_NOTE" = "1" ]; } && ok "DELETES did NOT propagate via delta — deleted rows LINGER (proves the gap the reconcile closes)" || bad "delete unexpectedly propagated via delta (wi=$LINGER_WI note=$LINGER_NOTE)"
# verify must now FAIL on the count mismatch (target has 2 lingering extras)
if npx tsx scripts/cutover/verify-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --out "$WORKDIR/v2.json" >/dev/null 2>&1; then
  bad "verify wrongly CLEAN while deleted rows linger (count should mismatch)"
else
  ok "verify FAILS post-delta (lingering deletes cause a count mismatch — the gate refuses the flip)"
fi
node -e '
  const r=require("'"$WORKDIR"'/v2.json");
  const fail=(m)=>{console.error("ASSERT-FAIL "+m);process.exitCode=3;};
  const wi=r.counts.find(c=>c.table==="work_items"); const nt=r.counts.find(c=>c.table==="notes");
  if (!wi||wi.ok) fail("work_items count should mismatch: "+JSON.stringify(wi));
  if (!nt||nt.ok) fail("notes count should mismatch: "+JSON.stringify(nt));
  console.log("    post-delta counts: work_items src="+wi.source+" tgt="+wi.target+" | notes src="+nt.source+" tgt="+nt.target);
' && ok "verify report shows the source<target count mismatch for work_items + notes" || bad "verify report did not show the expected mismatch"

echo ""
echo "════════════════════ 4. RECONCILE-ORG (final, under freeze): apply DELETES, verify CLEAN ════════════════════"
# Snapshot pre-reconcile invariant subjects.
GWIT_BEFORE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_item_types WHERE id='$GWIT'")"
USHARED_BEFORE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM users WHERE id='$USHARED'")"
OTHER_WI_BEFORE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE id='$OTHER_WI'")"  # should be 0 (never imported for TENANT)
RECON="$(npx tsx scripts/cutover/reconcile-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --stamp "$STAMP")"
RECON_CODE=$?
echo "$RECON" | grep -E 'delete-extras|RECONCILE_TOTALS|deleted|Phase|CLEAN' | tail -14
[ "$RECON_CODE" = "0" ] && ok "reconcile-org exited 0 (verify gate passed)" || bad "reconcile-org exited $RECON_CODE"
# the deleted rows are now GONE from the target
GONE_WI="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE id='$WI_GLOBAL'")"
GONE_NOTE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM notes WHERE id='$NOTE'")"
{ [ "$GONE_WI" = "0" ] && [ "$GONE_NOTE" = "0" ]; } && ok "reconcile APPLIED the deletes (lingering rows removed)" || bad "reconcile did not delete the lingering rows (wi=$GONE_WI note=$GONE_NOTE)"
# EXACT count match: target tenant counts == source tenant counts
TGT_WI="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE org_id='$TENANT'")"
TGT_NOTE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM notes WHERE org_id='$TENANT'")"
{ [ "$TGT_WI" = "$SRC_WI" ] && [ "$TGT_NOTE" = "$SRC_NOTE" ]; } && ok "EXACT count match after reconcile (work_items $TGT_WI==$SRC_WI, notes $TGT_NOTE==$SRC_NOTE)" || bad "counts not exact (wi $TGT_WI vs $SRC_WI, note $TGT_NOTE vs $SRC_NOTE)"
# verify CLEAN now
if npx tsx scripts/cutover/verify-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --out "$WORKDIR/v3.json" >/dev/null 2>&1; then
  ok "verify CLEAN after reconcile (exit 0) — counts + money + markings + checksums + referential"
else
  bad "verify FAILED after reconcile"; cat "$WORKDIR/v3.json"
fi
node -e '
  const r=require("'"$WORKDIR"'/v3.json");
  const fail=(m)=>{console.error("ASSERT-FAIL "+m);process.exitCode=3;};
  if(!r.clean) fail("not clean");
  if(r.counts.some(c=>!c.ok)) fail("count mismatches: "+JSON.stringify(r.counts.filter(c=>!c.ok)));
  if(!r.referential||!r.referential.ok||r.referential.orphans!==0) fail("referential not clean: "+JSON.stringify(r.referential));
  console.log("    post-reconcile verify: clean="+r.clean+", referential checked="+r.referential.checked+" orphans="+r.referential.orphans);
' && ok "post-reconcile verify report fully clean (0 count mismatches, orphan probe 0)" || bad "post-reconcile verify report not clean"

echo ""
echo "════════════════════ 5. INVARIANTS: closure parents + other-org rows preserved ════════════════════"
# the GLOBAL work_item_type (closure parent, org_id NULL) must NOT be deleted by the reconcile
GWIT_AFTER="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_item_types WHERE id='$GWIT' AND org_id IS NULL")"
{ [ "$GWIT_BEFORE" = "1" ] && [ "$GWIT_AFTER" = "1" ]; } && ok "closure parent: GLOBAL work_item_type (org_id NULL) NOT deleted by reconcile" || bad "closure parent global WIT wrongly deleted ($GWIT_BEFORE -> $GWIT_AFTER)"
# the two-org user (MEMBER-scoped closure parent) must NOT be deleted
USHARED_AFTER="$(psql_t "$TGT_NAME" "SELECT count(*) FROM users WHERE id='$USHARED'")"
{ [ "$USHARED_BEFORE" = "1" ] && [ "$USHARED_AFTER" = "1" ]; } && ok "closure parent: the two-org user (Dave) NOT deleted by reconcile" || bad "two-org user wrongly deleted ($USHARED_BEFORE -> $USHARED_AFTER)"
# the OTHER org must be entirely untouched (its row counts unchanged in the SOURCE, and never in target)
OTHER_WI_SRC="$(psql_t "$SRC_NAME" "SELECT count(*) FROM work_items WHERE org_id='$OTHER'")"
OTHER_WI_IN_TGT="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE org_id='$OTHER'")"
{ [ "$OTHER_WI_SRC" = "1" ] && [ "$OTHER_WI_IN_TGT" = "0" ]; } && ok "other org untouched: OTHER's work_item still in source, never in TENANT's target" || bad "other org touched (src=$OTHER_WI_SRC tgt=$OTHER_WI_IN_TGT)"
# re-running reconcile is idempotent: 0 deletes, still clean
RECON2="$(npx tsx scripts/cutover/reconcile-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --stamp "$STAMP")"
echo "$RECON2" | grep RECONCILE_TOTALS
echo "$RECON2" | grep -q '"deleted":0' && ok "reconcile re-run is idempotent (0 deletes, verify still clean)" || bad "reconcile re-run not idempotent"

echo ""
echo "════════════════════ 5b. L1 REGRESSION: cascaded SetNull (no updated_at bump) → force reconcile is CLEAN ════════════════════"
# The bug (review M1/L1): a source-side cascaded SetNull on an OPTIONAL SELF-RELATION
# (work_items.parent_id, Prisma-default onDelete:SetNull) does NOT bump the child's updated_at.
# So the soak delta (and a GUARDED final import) never propagates the NULL → the target keeps a
# stale parent_id → after delete-extras removes the parent the child has a DANGLING self-FK →
# the orphan probe ROLLS BACK the entire reconcile (a spurious cutover HALT). The fix: the FINAL
# reconcile imports in FORCE/EXACT mode → the child's parent_id is force-updated to NULL to match
# the frozen source → the parent delete leaves no dangle → orphan probe CLEAN, no rollback.
L1_PARENT="66666666-0000-0000-0000-0000000000b1"  # a parent work_item (will be deleted in source)
L1_CHILD="66666666-0000-0000-0000-0000000000b2"   # a child whose parent_id -> L1_PARENT
# Insert the parent + child into the SOURCE (newer updated_at so the soak delta picks them up).
psql_t "$SRC_NAME" "INSERT INTO work_items (id, org_id, project_id, title, column_key, ticket_number, work_item_type_id, created_by_id, created_at, updated_at) VALUES ('$L1_PARENT','$TENANT','33333333-0000-0000-0000-000000000001','L1 parent','todo',20,'44444444-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','2026-06-07T03:00:00Z','2026-06-07T03:00:00Z')" >/dev/null
psql_t "$SRC_NAME" "INSERT INTO work_items (id, org_id, project_id, title, column_key, ticket_number, work_item_type_id, parent_id, created_by_id, created_at, updated_at) VALUES ('$L1_CHILD','$TENANT','33333333-0000-0000-0000-000000000001','L1 child','todo',21,'44444444-0000-0000-0000-000000000001','$L1_PARENT','11111111-0000-0000-0000-000000000001','2026-06-07T03:00:00Z','2026-06-07T03:00:00Z')" >/dev/null
# Soak the pair into the target.
npx tsx scripts/cutover/soak-sync.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --state "$STATE" --stamp "$STAMP" >/dev/null
L1_CHILD_PARENT_TGT="$(psql_t "$TGT_NAME" "SELECT parent_id FROM work_items WHERE id='$L1_CHILD'")"
[ "$L1_CHILD_PARENT_TGT" = "$L1_PARENT" ] && ok "L1 setup: child synced to target WITH parent_id set" || bad "L1 setup: child parent_id not synced ($L1_CHILD_PARENT_TGT)"
# Now in the SOURCE: delete the parent. The real FK is ON DELETE SET NULL, so the child's
# parent_id is cascaded to NULL by the DB — and a cascaded SetNull does NOT bump updated_at.
# Force the updated_at to STAY at its old value to model the no-bump precisely (belt + suspenders).
psql_t "$SRC_NAME" "DELETE FROM work_items WHERE id='$L1_PARENT'" >/dev/null
psql_t "$SRC_NAME" "UPDATE work_items SET updated_at='2026-06-07T03:00:00Z' WHERE id='$L1_CHILD'" >/dev/null
L1_CHILD_PARENT_SRC="$(psql_t "$SRC_NAME" "SELECT parent_id FROM work_items WHERE id='$L1_CHILD'")"
[ -z "$L1_CHILD_PARENT_SRC" ] && ok "L1 source: parent deleted, child's parent_id cascaded to NULL (no updated_at bump)" || bad "L1 source: child parent_id not NULL in source ($L1_CHILD_PARENT_SRC)"
# Soak delta: the guarded path MISSES the SetNull (updated_at unchanged) → the target STILL points
# the child at the now-deleted parent (the lingering stale self-FK the review describes).
npx tsx scripts/cutover/soak-sync.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --state "$STATE" --stamp "$STAMP" >/dev/null
L1_CHILD_PARENT_AFTER_DELTA="$(psql_t "$TGT_NAME" "SELECT parent_id FROM work_items WHERE id='$L1_CHILD'")"
[ "$L1_CHILD_PARENT_AFTER_DELTA" = "$L1_PARENT" ] && ok "L1: soak delta MISSED the SetNull (target keeps stale parent_id — the gap force-reconcile closes)" || bad "L1: delta unexpectedly cleared parent_id ($L1_CHILD_PARENT_AFTER_DELTA)"
# FINAL reconcile (force/exact import). It must: (a) force-update the child's parent_id to NULL to
# match the frozen source, (b) delete-extras the now-extra parent, (c) orphan probe CLEAN (no
# dangling self-FK) → COMMIT (NOT roll back). WITHOUT the force fix this would have rolled back on
# the dangling work_items.parent_id self-FK (see review L1).
RECON_L1="$(npx tsx scripts/cutover/reconcile-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --stamp "$STAMP")"
RECON_L1_CODE=$?
echo "$RECON_L1" | grep -E 'FORCE|delete-extras|orphan probe CLEAN|RECONCILE_TOTALS' | tail -6
[ "$RECON_L1_CODE" = "0" ] && ok "L1: force reconcile exited 0 (orphan probe CLEAN — NO spurious rollback)" || { bad "L1: force reconcile exited $RECON_L1_CODE (the SetNull-no-bump rollback regressed)"; echo "$RECON_L1" | tail -20; }
echo "$RECON_L1" | grep -q 'FORCE (EXACT) mode' && ok "L1: Phase-1 import ran in FORCE/EXACT mode" || bad "L1: force mode not engaged in the reconcile"
# The child's parent_id is now NULL in the target (force-updated to match source) and the parent is gone.
L1_CHILD_PARENT_FINAL="$(psql_t "$TGT_NAME" "SELECT parent_id FROM work_items WHERE id='$L1_CHILD'")"
L1_PARENT_GONE="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE id='$L1_PARENT'")"
{ [ -z "$L1_CHILD_PARENT_FINAL" ] && [ "$L1_PARENT_GONE" = "0" ]; } && ok "L1: child parent_id force-updated to NULL + parent deleted as extra (target EXACTLY matches source)" || bad "L1: not exact (child parent_id='$L1_CHILD_PARENT_FINAL', parent rows=$L1_PARENT_GONE)"
# Verify CLEAN (the child is retained, no orphan, exact counts).
if npx tsx scripts/cutover/verify-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --out "$WORKDIR/v-l1.json" >/dev/null 2>&1; then
  ok "L1: verify CLEAN after force reconcile (child retained, self-FK resolved, no orphan)"
else
  bad "L1: verify FAILED after force reconcile"; cat "$WORKDIR/v-l1.json"
fi

echo ""
echo "════════════════════ 6. NEGATIVE: a deliberately-orphaning delete is caught (rollback) ════════════════════"
# A genuine orphaning delete that exercises the delete-extras orphan gate: delete a MUTABLE,
# org-owned, delete-eligible PARENT (chat_channels) from the SOURCE while its APPEND-ONLY children
# (chat_messages — NOT delete-eligible, immutable history) remain in the target. The reconcile will
# delete-extras the now-extra channel, but it can NOT delete the append-only messages, so
# chat_messages.channel_id would DANGLE. The in-transaction orphan probe (Phase 3) must catch this
# and ROLLBACK the entire reconcile (fail-closed). The channel + messages already synced earlier.
CHAN="88888888-0000-0000-0000-000000000001"
# Sanity: the channel + its messages are present in the target from the earlier sync.
CHAN_IN_TGT="$(psql_t "$TGT_NAME" "SELECT count(*) FROM chat_channels WHERE id='$CHAN'")"
MSGS_IN_TGT="$(psql_t "$TGT_NAME" "SELECT count(*) FROM chat_messages WHERE channel_id='$CHAN'")"
echo "    pre-negative target: chat_channel=$CHAN_IN_TGT, chat_messages=$MSGS_IN_TGT (append-only, not delete-eligible)"
# Delete the channel from the SOURCE under replica role (its messages reference it via RESTRICT).
# The messages stay in BOTH source and target, but the source no longer org-scopes them (their
# channel is gone), and the target's append-only messages can't be removed -> the deleted channel
# strands them once delete-extras removes the channel from the target.
$D exec "$SRC_NAME" psql -U cosmos -d cosmos -c "BEGIN; SET session_replication_role=replica; DELETE FROM chat_channels WHERE id='$CHAN'; COMMIT;" >/dev/null
# reconcile must FAIL CLOSED (orphan probe catches the would-be dangling chat_messages.channel_id).
if npx tsx scripts/cutover/reconcile-org.mjs --source "$SRC" --target "$TGT" --org "$TENANT" --stamp "$STAMP" >"$WORKDIR/recon-neg.out" 2>&1; then
  bad "reconcile did NOT fail on a deliberately-orphaning delete (should fail closed)"
else
  ok "reconcile FAILED CLOSED on the orphaning delete (orphan probe rolled the reconcile back)"
fi
grep -qiE 'dangling FK|chat_messages.channel_id|ROLLING BACK' "$WORKDIR/recon-neg.out" && ok "reconcile names the would-be dangling FK (chat_messages.channel_id) in its rollback" || { bad "reconcile rollback did not name the dangling FK"; tail -8 "$WORKDIR/recon-neg.out"; }
# CRITICAL: the rollback must leave the target UNCHANGED — the channel must still be present
# (the delete was rolled back), proving the all-or-nothing transaction.
CHAN_AFTER_NEG="$(psql_t "$TGT_NAME" "SELECT count(*) FROM chat_channels WHERE id='$CHAN'")"
[ "$CHAN_AFTER_NEG" = "1" ] && ok "rollback left the target intact (the channel was NOT deleted — all-or-nothing)" || bad "rollback did not restore the channel ($CHAN_AFTER_NEG) — partial delete leaked!"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "SOAK+RECONCILE ACCEPTANCE: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
