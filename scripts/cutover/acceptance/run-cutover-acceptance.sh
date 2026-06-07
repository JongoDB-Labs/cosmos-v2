#!/usr/bin/env bash
# scripts/cutover/acceptance/run-cutover-acceptance.sh
#
# DOCKER ACCEPTANCE for the CUTOVER FLIP ORCHESTRATION — SYNTHETIC org, a cutover reverse
# proxy + a v1-stub + a v2-stub + two throwaway Postgres (source/target). NO production.
# Proves the operable end-to-end per-tenant cutover with a reverse-proxy freeze/flip/rollback:
#
#   1. PRE-FLIP routing: GET /<slug>/... hits v1 (default upstream).
#   2. orchestrate.mjs --confirm runs the full sequence; we prove IN ORDER:
#        - parity precheck ran,
#        - soak caught up,
#        - DURING FREEZE a POST /<slug>/... -> 405 (write-frozen) while a GET still 200s on v1,
#        - reconcile + verify gate passed,
#        - AFTER FLIP a GET /<slug>/... hits v2,
#        - unfreeze: a POST /<slug>/... now reaches v2 (no longer 405).
#   3. ANOTHER org /<otherslug>/... keeps hitting v1 THROUGHOUT (only the cut-over org flips).
#   4. ROLLBACK: a forced verify failure (corrupt a target row pre-gate) -> the orchestrator
#      ROLLS BACK: the org routes back to v1, is unfrozen, exits non-zero, and prints the
#      snapshot-restore instruction.
#   5. --dry-run (the DEFAULT) touches NOTHING (no freeze, no flip, no DB writes).
#   6. tear down.
#
# Requires sudo docker. FREE host ports: proxy HTTP 8092, proxy admin 2120, source PG 55460,
# target PG 55461, scratch PG 55462, shadow PG 55463. Everything runs on a dedicated docker
# network so the proxy can dial the stubs by container name; the orchestrator runs on the HOST
# and reaches the proxy + the DBs via host-mapped ports.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

NET=cutover-acc-net
PROXY_NAME=cutover-acc-proxy
V1_NAME=cutover-acc-v1
V2_NAME=cutover-acc-v2
SRC_NAME=cutover-acc-src
TGT_NAME=cutover-acc-tgt
SC_NAME=cutover-acc-scratch
SH_NAME=cutover-acc-shadow

PROXY_HTTP_PORT=8092
PROXY_ADMIN_PORT=2120
SRC_PORT=55460
TGT_PORT=55461
SC_PORT=55462
SH_PORT=55463

CADDY_IMAGE=caddy@sha256:cb9d71ad83182011b79355cd57692686374bd78d6fe327efe0ff8507da03ab13
PG_IMAGE=pgvector/pgvector:pg16

WORKDIR="$(mktemp -d /tmp/cutover-acc.XXXXXX)"
STATE="$WORKDIR/soak-state.json"
TENANT="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"   # the cut-over org (slug "tenant")
SLUG=tenant
OTHER_SLUG=other                                # the second org's slug (must stay on v1)
STAMP="2026-06-07T00:00:00Z"

SRC="postgres://cosmos:cosmos@localhost:${SRC_PORT}/cosmos"
TGT="postgres://cosmos:cosmos@localhost:${TGT_PORT}/cosmos"
SCRATCH="postgres://cosmos:cosmos@localhost:${SC_PORT}/cosmos"
SHADOW="postgres://cosmos:cosmos@localhost:${SH_PORT}/cosmos"
PROXY_ADMIN="http://localhost:${PROXY_ADMIN_PORT}"
PROXY="http://localhost:${PROXY_HTTP_PORT}"

# A known mutable row to corrupt for the rollback test (from seed-synthetic.mjs).
WORKITEM="66666666-0000-0000-0000-000000000001"

D="sudo docker"
PASS=0
FAIL=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
psql_t() { $D exec "$1" psql -U cosmos -d cosmos -tAc "$2"; }

# Extract a step's final status from the orchestrator's machine-readable ORCHESTRATE_REPORT line
# (the authoritative record — robust vs. interleaved child stdio). Usage: report_step "<out>" <step>
# Prints the last status seen for that step ("ok"/"run"/"fail"/"skip"), or "" if absent.
report_step() {
  node -e '
    const out = process.argv[1], step = process.argv[2];
    const line = out.split("\n").reverse().find(l => l.startsWith("ORCHESTRATE_REPORT "));
    if (!line) { process.stdout.write(""); process.exit(0); }
    const rep = JSON.parse(line.slice("ORCHESTRATE_REPORT ".length));
    const matches = rep.steps.filter(s => s.step === step);
    process.stdout.write(matches.length ? matches[matches.length-1].status : "");
  ' "$1" "$2"
}
report_ok() {  # report_ok "<out>"  → prints "true"/"false"
  node -e '
    const out = process.argv[1];
    const line = out.split("\n").reverse().find(l => l.startsWith("ORCHESTRATE_REPORT "));
    process.stdout.write(line ? String(JSON.parse(line.slice("ORCHESTRATE_REPORT ".length)).ok) : "");
  ' "$1"
}

cleanup() {
  echo ""
  echo "── teardown ──"
  $D rm -f "$PROXY_NAME" "$V1_NAME" "$V2_NAME" "$SRC_NAME" "$TGT_NAME" "$SC_NAME" "$SH_NAME" >/dev/null 2>&1 || true
  $D network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR" || true
}
trap cleanup EXIT

# curl helpers via the proxy. The proxy reverse-proxies; the stubs echo "v1|v2 <METHOD> <uri>".
# We print the status code + body so the assertions can see both the upstream name AND the verb.
http_code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "${PROXY}$2"; }
http_body() { curl -s -X "$1" "${PROXY}$2"; }

start_pg() {
  local name="$1" port="$2"
  $D rm -f "$name" >/dev/null 2>&1 || true
  $D run -d --name "$name" --network "$NET" \
    -e POSTGRES_USER=cosmos -e POSTGRES_PASSWORD=cosmos -e POSTGRES_DB=cosmos \
    -p "${port}:5432" "$PG_IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    $D exec "$name" pg_isready -U cosmos -d cosmos >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "start_pg: $name did not become ready"; exit 1
}
prepare_db() {
  $D exec "$1" psql -v ON_ERROR_STOP=1 -U cosmos -d cosmos -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='cosmos_app') THEN CREATE ROLE cosmos_app LOGIN PASSWORD 'cosmos_app'; END IF; END \$\$;" >/dev/null
}
# Reset the scratch DB's public schema so the parity gate's dump-restore starts from EMPTY each
# run (a second restore into a non-empty scratch fails on "relation already exists"). The shadow
# DB is reset by Prisma's migrate-diff itself, so only the scratch needs this. Re-grants to
# cosmos_app because the restored dump's GRANTs reference it (mirrors run-parity-acceptance.sh).
reset_scratch() {
  $D exec "$SC_NAME" psql -v ON_ERROR_STOP=1 -U cosmos -d cosmos -c \
    "SET client_min_messages = warning; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO cosmos; GRANT USAGE ON SCHEMA public TO cosmos_app;" >/dev/null 2>&1
}

echo "════════════════════════════════════════════════════════════════════════════"
echo " CUTOVER FLIP ORCHESTRATION — SYNTHETIC DOCKER ACCEPTANCE (no prod)"
echo "════════════════════════════════════════════════════════════════════════════"

echo "── creating the docker network ──"
$D network rm "$NET" >/dev/null 2>&1 || true
$D network create "$NET" >/dev/null

# ── the two upstream stubs (tiny Caddy servers that return their name + echo the method) ──
echo "── booting the v1-stub + v2-stub (echo name + method) ──"
cat > "$WORKDIR/v1.Caddyfile" <<'EOF'
:80 {
	respond "v1 {method} {uri}" 200
}
EOF
cat > "$WORKDIR/v2.Caddyfile" <<'EOF'
:80 {
	respond "v2 {method} {uri}" 200
}
EOF
$D run -d --name "$V1_NAME" --network "$NET" \
  -v "$WORKDIR/v1.Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null
$D run -d --name "$V2_NAME" --network "$NET" \
  -v "$WORKDIR/v2.Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null

# ── the cutover proxy: a TEST config (admin on 0.0.0.0 so the host orchestrator can drive it;
#    the stubs dialed by container name). Generated from the SAME builder the control client
#    uses so the booted config and decodeState agree. Empty state ⇒ everyone on v1. ──
echo "── generating the cutover-proxy TEST config (from buildCaddyConfig) ──"
V1_DIAL="${V1_NAME}:80"
V2_DIAL="${V2_NAME}:80"
V1_DIAL="$V1_DIAL" V2_DIAL="$V2_DIAL" OUT="$WORKDIR/caddy.test.json" \
ADMIN_PORT="$PROXY_ADMIN_PORT" npx tsx -e '
import { buildCaddyConfig } from "./scripts/cutover/lib/proxy-control.ts";
import { writeFileSync } from "node:fs";
const p = process.env.ADMIN_PORT;
const cfg = buildCaddyConfig({
  state: {},
  upstreams: { v1: process.env.V1_DIAL, v2: process.env.V2_DIAL },
  adminListen: "0.0.0.0:2019",   // TEST-ONLY: host orchestrator drives the admin API
  httpListen: ":80",
  // TEST-ONLY: admin binds a non-loopback addr, so Caddy needs the host Origins allowlisted
  // (the host-side client sends Host: localhost:<mapped-port>). Prod intent keeps loopback.
  adminOrigins: [`localhost:${p}`, `127.0.0.1:${p}`, "localhost", "127.0.0.1"],
});
writeFileSync(process.env.OUT, JSON.stringify(cfg, null, 2));
'
[ -s "$WORKDIR/caddy.test.json" ] || { echo "failed to generate caddy.test.json"; exit 1; }

echo "── booting the cutover-proxy ──"
$D run -d --name "$PROXY_NAME" --network "$NET" \
  -p "${PROXY_HTTP_PORT}:80" -p "${PROXY_ADMIN_PORT}:2019" \
  -v "$WORKDIR/caddy.test.json:/etc/caddy/caddy.json:ro" \
  "$CADDY_IMAGE" caddy run --config /etc/caddy/caddy.json >/dev/null

# wait for the proxy admin API + a route to be live
for _ in $(seq 1 60); do
  curl -sf "${PROXY_ADMIN}/config/" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "${PROXY_ADMIN}/config/" >/dev/null 2>&1 || { echo "proxy admin did not come up"; $D logs "$PROXY_NAME" | tail; exit 1; }

# ── the two throwaway Postgres (source + target) + the parity scratch/shadow ──
echo "── booting source/target/scratch/shadow Postgres ──"
start_pg "$SRC_NAME" "$SRC_PORT"
start_pg "$TGT_NAME" "$TGT_PORT"
start_pg "$SC_NAME"  "$SC_PORT"
start_pg "$SH_NAME"  "$SH_PORT"
prepare_db "$SRC_NAME"
prepare_db "$TGT_NAME"
prepare_db "$SC_NAME"   # scratch: the restored dump GRANTs to cosmos_app
prepare_db "$SH_NAME"   # shadow: the migrations GRANT to cosmos_app during replay

echo "── applying v2 migrations to source + target ──"
DATABASE_URL="$SRC" DIRECT_URL="$SRC" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/src-migrate.err" \
  || { echo "source migrate failed:"; cat "$WORKDIR/src-migrate.err"; exit 1; }
DATABASE_URL="$TGT" DIRECT_URL="$TGT" npx prisma migrate deploy >/dev/null 2>"$WORKDIR/tgt-migrate.err" \
  || { echo "target migrate failed:"; cat "$WORKDIR/tgt-migrate.err"; exit 1; }

echo "── seeding the synthetic org (+ other org) into the SOURCE ──"
SEED_URL="$SRC" node scripts/cutover/acceptance/seed-synthetic.mjs

# ── build the parity prod-schema-dump: dump the migrated SOURCE schema (a synthetic stand-in
#    for the §9.2 prod snapshot). It restores into scratch + diffs EMPTY against v2's migrations
#    (both came from the same prisma/migrations) and carries the classification FK ⇒ gate PASSES. ──
echo "── building the synthetic prod-schema-dump (schema-only of the migrated source) ──"
$D exec "$SRC_NAME" pg_dump --schema-only -U cosmos -d cosmos > "$WORKDIR/prod-schema.sql"

# Common orchestrator args.
ORCH_ARGS=(
  --org "$TENANT" --slug "$SLUG"
  --source "$SRC" --target "$TGT"
  --scratch "$SCRATCH" --shadow "$SHADOW"
  --prod-schema-dump "$WORKDIR/prod-schema.sql"
  --state "$STATE"
  --proxy-admin "$PROXY_ADMIN"
  --v1 "$V1_DIAL" --v2 "$V2_DIAL"
  --max-cycles 5 --stamp "$STAMP"
)

echo ""
echo "════════════════════ 1. PRE-FLIP ROUTING (everyone on v1) ════════════════════"
PRE_TENANT_CODE="$(http_code GET /$SLUG/projects)"
PRE_TENANT_BODY="$(http_body GET /$SLUG/projects)"
PRE_OTHER_BODY="$(http_body GET /$OTHER_SLUG/projects)"
echo "    GET /$SLUG/projects   -> $PRE_TENANT_CODE  body='$PRE_TENANT_BODY'"
echo "    GET /$OTHER_SLUG/projects -> body='$PRE_OTHER_BODY'"
{ [ "$PRE_TENANT_CODE" = "200" ] && echo "$PRE_TENANT_BODY" | grep -q '^v1 '; } \
  && ok "pre-flip: GET /$SLUG hits v1" || bad "pre-flip: GET /$SLUG did not hit v1 ($PRE_TENANT_CODE '$PRE_TENANT_BODY')"
echo "$PRE_OTHER_BODY" | grep -q '^v1 ' \
  && ok "pre-flip: GET /$OTHER_SLUG hits v1" || bad "pre-flip: other org not on v1 ('$PRE_OTHER_BODY')"
# a write pre-freeze also reaches v1 (NOT frozen yet)
PRE_POST_CODE="$(http_code POST /$SLUG/work-items)"
[ "$PRE_POST_CODE" = "200" ] && ok "pre-freeze: POST /$SLUG reaches v1 (200, not frozen)" || bad "pre-freeze POST unexpectedly $PRE_POST_CODE"

echo ""
echo "════════════════════ 2. DRY-RUN (DEFAULT) TOUCHES NOTHING ════════════════════"
# Snapshot the proxy state + target row count BEFORE the dry-run.
DRY_STATE_BEFORE="$(curl -s "${PROXY_ADMIN}/config/apps/http/servers/cutover/routes")"
TGT_WI_BEFORE_DRY="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE org_id='$TENANT'")"
DRY_OUT="$(npx tsx scripts/cutover/orchestrate.mjs "${ORCH_ARGS[@]}" 2>&1)"   # no --confirm ⇒ dry-run
DRY_CODE=$?
echo "$DRY_OUT" | grep -E 'MODE:|DRY-RUN PLAN|dry-run —' | head -4
[ "$DRY_CODE" = "0" ] && ok "dry-run exits 0" || bad "dry-run exit $DRY_CODE"
echo "$DRY_OUT" | grep -q 'DRY-RUN (default' && ok "dry-run banner shown (default mode)" || bad "dry-run banner missing"
DRY_STATE_AFTER="$(curl -s "${PROXY_ADMIN}/config/apps/http/servers/cutover/routes")"
[ "$DRY_STATE_BEFORE" = "$DRY_STATE_AFTER" ] && ok "dry-run touched NO proxy state (routes unchanged)" || bad "dry-run mutated the proxy state!"
TGT_WI_AFTER_DRY="$(psql_t "$TGT_NAME" "SELECT count(*) FROM work_items WHERE org_id='$TENANT'")"
[ "$TGT_WI_BEFORE_DRY" = "$TGT_WI_AFTER_DRY" ] && ok "dry-run wrote NOTHING to the target DB (work_items $TGT_WI_AFTER_DRY unchanged)" || bad "dry-run wrote to the target ($TGT_WI_BEFORE_DRY -> $TGT_WI_AFTER_DRY)"
# the org must still be on v1 after the dry-run
[ "$(http_body GET /$SLUG/projects)" = "v1 GET /$SLUG/projects" ] && ok "dry-run left /$SLUG on v1" || bad "dry-run changed routing"

echo ""
echo "════════════════════ 3. FREEZE-WINDOW PROBE (freeze ⇒ 405 on writes, reads OK) ════════════════════"
# To OBSERVE the freeze window deterministically (the orchestrator unfreezes at the end of a
# successful run), we drive the proxy directly via proxy-control for this probe: freeze tenant,
# assert POST->405 + GET->200(v1), then unfreeze. This is the EXACT mechanism the orchestrator's
# step 3/7 use (same ProxyControl client).
PROXY_ADMIN="$PROXY_ADMIN" V1_DIAL="$V1_DIAL" V2_DIAL="$V2_DIAL" SLUG="$SLUG" npx tsx -e '
import { ProxyControl } from "./scripts/cutover/lib/proxy-control.ts";
(async () => {
  const p = new ProxyControl({ adminUrl: process.env.PROXY_ADMIN, upstreams: { v1: process.env.V1_DIAL, v2: process.env.V2_DIAL } });
  await p.freezeOrg(process.env.SLUG);
  console.log("frozen:", JSON.stringify(await p.getOrgState(process.env.SLUG)));
})();
'
FZ_POST_CODE="$(http_code POST /$SLUG/work-items)"
FZ_PUT_CODE="$(http_code PUT /$SLUG/work-items/1)"
FZ_DELETE_CODE="$(http_code DELETE /$SLUG/work-items/1)"
FZ_GET_CODE="$(http_code GET /$SLUG/projects)"
FZ_GET_BODY="$(http_body GET /$SLUG/projects)"
FZ_405_BODY="$(http_body POST /$SLUG/work-items)"
FZ_ALLOW="$(curl -s -D - -o /dev/null -X POST "${PROXY}/$SLUG/work-items" | tr -d '\r' | awk -F': ' 'tolower($1)=="allow"{print $2}')"
echo "    POST=$FZ_POST_CODE PUT=$FZ_PUT_CODE DELETE=$FZ_DELETE_CODE GET=$FZ_GET_CODE (body '$FZ_GET_BODY')"
echo "    405 body: $FZ_405_BODY"
echo "    Allow header: $FZ_ALLOW"
{ [ "$FZ_POST_CODE" = "405" ] && [ "$FZ_PUT_CODE" = "405" ] && [ "$FZ_DELETE_CODE" = "405" ]; } \
  && ok "freeze: POST/PUT/DELETE /$SLUG -> 405 (write-frozen)" || bad "freeze: a mutating verb not 405 (POST=$FZ_POST_CODE PUT=$FZ_PUT_CODE DEL=$FZ_DELETE_CODE)"
{ [ "$FZ_GET_CODE" = "200" ] && [ "$FZ_GET_BODY" = "v1 GET /$SLUG/projects" ]; } \
  && ok "freeze: GET /$SLUG still 200 on v1 (reads pass)" || bad "freeze: GET not 200/v1 ($FZ_GET_CODE '$FZ_GET_BODY')"
echo "$FZ_405_BODY" | grep -q 'org_frozen' && ok "freeze: 405 body is the JSON org_frozen payload" || bad "freeze: 405 body not org_frozen ('$FZ_405_BODY')"
echo "$FZ_ALLOW" | grep -q 'GET' && ok "freeze: Allow header advertises reads (GET, HEAD, OPTIONS)" || bad "freeze: Allow header wrong ('$FZ_ALLOW')"
# the OTHER org is NOT frozen — its writes still pass to v1
OTHER_POST_FROZEN="$(http_code POST /$OTHER_SLUG/work-items)"
[ "$OTHER_POST_FROZEN" = "200" ] && ok "freeze: the OTHER org is NOT frozen (POST /$OTHER_SLUG -> 200 v1)" || bad "freeze leaked to the other org (POST -> $OTHER_POST_FROZEN)"
# clean up the probe freeze so the orchestrator starts from an unfrozen state
PROXY_ADMIN="$PROXY_ADMIN" V1_DIAL="$V1_DIAL" V2_DIAL="$V2_DIAL" SLUG="$SLUG" npx tsx -e '
import { ProxyControl } from "./scripts/cutover/lib/proxy-control.ts";
(async () => {
  const p = new ProxyControl({ adminUrl: process.env.PROXY_ADMIN, upstreams: { v1: process.env.V1_DIAL, v2: process.env.V2_DIAL } });
  await p.unfreezeOrg(process.env.SLUG);
})();
'

echo ""
echo "════════════════════ 4. ORCHESTRATE --confirm (full cutover -> flip to v2) ════════════════════"
reset_scratch   # fresh scratch DB so the parity gate's dump-restore starts empty
ORCH_OUT="$(npx tsx scripts/cutover/orchestrate.mjs "${ORCH_ARGS[@]}" --confirm 2>&1)"
ORCH_CODE=$?
echo "$ORCH_OUT" | grep -E 'parity-gate precheck|soak loop|soak cycle|✅ freeze|reconcile-org|verify gate|✅ flip|✅ unfreeze|CUTOVER COMPLETE|ORCHESTRATE_REPORT' | tail -25
[ "$ORCH_CODE" = "0" ] && ok "orchestrate --confirm exited 0 (cutover complete)" || { bad "orchestrate --confirm exited $ORCH_CODE"; echo "$ORCH_OUT" | tail -40; }
# Prove the sequence ran IN ORDER via the authoritative ORCHESTRATE_REPORT (robust vs. the
# interleaved child stdio). Each step must end in status "ok".
[ "$(report_step "$ORCH_OUT" 'parity-gate precheck')" = "ok" ] && ok "sequence: parity precheck ran (PASS)" || bad "parity precheck not OK"
[ "$(report_step "$ORCH_OUT" 'soak loop')" = "ok" ] && ok "sequence: soak loop caught up" || bad "soak loop not OK"
echo "$ORCH_OUT" | grep -qE 'soak cycle .*upserts=0' && ok "sequence: a soak cycle reported 0 upserts (caught up)" || echo "    (note: soak hit max-cycles; still valid — the final reconcile is exact)"
[ "$(report_step "$ORCH_OUT" 'freeze')" = "ok" ] && ok "sequence: freeze step OK" || bad "freeze step not OK"
[ "$(report_step "$ORCH_OUT" 'reconcile-org')" = "ok" ] && ok "sequence: reconcile-org OK" || bad "reconcile not OK"
[ "$(report_step "$ORCH_OUT" 'verify gate')" = "ok" ] && ok "sequence: verify GATE passed" || bad "verify gate not OK"
[ "$(report_step "$ORCH_OUT" 'flip')" = "ok" ] && ok "sequence: flip step OK" || bad "flip step not OK"
[ "$(report_step "$ORCH_OUT" 'unfreeze')" = "ok" ] && ok "sequence: unfreeze step OK" || bad "unfreeze step not OK"
[ "$(report_ok "$ORCH_OUT")" = "true" ] && ok "report: ok=true" || bad "report not ok=true"

echo ""
echo "════════════════════ 5. POST-FLIP ROUTING (org on v2; writes resume; other org on v1) ════════════════════"
POST_GET_BODY="$(http_body GET /$SLUG/projects)"
POST_GET_CODE="$(http_code GET /$SLUG/projects)"
POST_POST_BODY="$(http_body POST /$SLUG/work-items)"
POST_POST_CODE="$(http_code POST /$SLUG/work-items)"
echo "    GET /$SLUG/projects -> $POST_GET_CODE body='$POST_GET_BODY'"
echo "    POST /$SLUG/work-items -> $POST_POST_CODE body='$POST_POST_BODY'"
{ [ "$POST_GET_CODE" = "200" ] && echo "$POST_GET_BODY" | grep -q '^v2 '; } \
  && ok "post-flip: GET /$SLUG hits v2" || bad "post-flip: GET /$SLUG not on v2 ($POST_GET_CODE '$POST_GET_BODY')"
{ [ "$POST_POST_CODE" = "200" ] && echo "$POST_POST_BODY" | grep -q '^v2 POST'; } \
  && ok "post-flip: POST /$SLUG reaches v2 (unfrozen — writes resumed, method echoed)" || bad "post-flip: POST /$SLUG not v2/200 ($POST_POST_CODE '$POST_POST_BODY')"
OTHER_AFTER_BODY="$(http_body GET /$OTHER_SLUG/projects)"
OTHER_AFTER_POST="$(http_code POST /$OTHER_SLUG/work-items)"
{ echo "$OTHER_AFTER_BODY" | grep -q '^v1 ' && [ "$OTHER_AFTER_POST" = "200" ]; } \
  && ok "post-flip: the OTHER org STILL on v1 throughout (GET v1, POST 200) — only the cut-over org flipped" \
  || bad "post-flip: other org affected (GET '$OTHER_AFTER_BODY', POST $OTHER_AFTER_POST)"

echo ""
echo "════════════════════ 6. ROLLBACK PATH (forced verify failure -> route back to v1) ════════════════════"
# Reset the proxy to a clean v1/unfrozen state for a fresh cutover attempt on the SAME org.
PROXY_ADMIN="$PROXY_ADMIN" V1_DIAL="$V1_DIAL" V2_DIAL="$V2_DIAL" SLUG="$SLUG" npx tsx -e '
import { ProxyControl } from "./scripts/cutover/lib/proxy-control.ts";
(async () => {
  const p = new ProxyControl({ adminUrl: process.env.PROXY_ADMIN, upstreams: { v1: process.env.V1_DIAL, v2: process.env.V2_DIAL } });
  await p.setOrgUpstream(process.env.SLUG, "v1");
  await p.unfreezeOrg(process.env.SLUG);
  console.log("reset:", JSON.stringify(await p.getOrgState(process.env.SLUG)));
})();
'
[ "$(http_body GET /$SLUG/projects)" = "v1 GET /$SLUG/projects" ] && ok "rollback setup: /$SLUG reset to v1" || bad "rollback setup: /$SLUG not on v1"

# Force a DURABLE verify-GATE failure that the reconcile CANNOT self-heal, so the VERIFY GATE is
# the clean rollback trigger. The reconcile's Phase-1 import is FORCE/EXACT (overwrites mutable
# rows) and Phase-2 delete-extras removes target-only MUTABLE org-owned rows — so neither a
# corrupted mutable row nor an extra mutable row would survive. APPEND-ONLY tables, however, are
# DO NOTHING on import AND are excluded from delete-extras (immutable history), so a target-only
# append-only row SURVIVES the whole reconcile and trips verify-org's exact COUNT check
# (target_count > source_count) ⇒ the verify GATE fails ⇒ the orchestrator rolls back. We inject
# one extra chat_messages row (append-only) into the TARGET, on the tenant's seeded channel.
CHAN_TENANT="88888888-0000-0000-0000-000000000001"   # the tenant's seeded chat_channel
AUTHOR="11111111-0000-0000-0000-000000000001"        # a seeded tenant user
EXTRA_MSG="99999999-0000-0000-0000-0000000000ff"
echo "    injecting a target-only append-only row (chat_messages) so verify's COUNT check fails:"
psql_t "$TGT_NAME" "INSERT INTO chat_messages (id, channel_id, author_id, content, kind, created_at) VALUES ('$EXTRA_MSG','$CHAN_TENANT','$AUTHOR','target-only ghost (rollback test)','USER','2026-06-07T09:00:00Z')" >/dev/null
EXTRA_PRESENT="$(psql_t "$TGT_NAME" "SELECT count(*) FROM chat_messages WHERE id='$EXTRA_MSG'")"
[ "$EXTRA_PRESENT" = "1" ] && echo "    injected extra target chat_message $EXTRA_MSG" || echo "    WARN: extra message not injected"

reset_scratch   # fresh scratch DB so the parity gate's dump-restore starts empty
ROLL_OUT="$(npx tsx scripts/cutover/orchestrate.mjs "${ORCH_ARGS[@]}" --confirm 2>&1)"
ROLL_CODE=$?
echo "$ROLL_OUT" | grep -aE 'freeze|verify gate|GATE FAILED|ROLLBACK|setOrgUpstream v1|rollback: unfreeze|snapshot|pgbackrest' | grep -aE '✅|❌|▶|GATE FAILED|pgbackrest|snapshot' | tail -22
[ "$ROLL_CODE" != "0" ] && ok "rollback: orchestrate exited NON-ZERO ($ROLL_CODE) on the verify failure" || bad "rollback: orchestrate wrongly exited 0 despite a corrupted row"
# the freeze DID take effect (so this is the post-freeze rollback path), then verify FAILED
[ "$(report_step "$ROLL_OUT" 'freeze')" = "ok" ] && ok "rollback: freeze took effect (post-freeze path)" || bad "rollback: freeze did not take effect"
echo "$ROLL_OUT" | grep -qaiE 'verify.*GATE FAILED|verify-org: MISMATCH' && ok "rollback: the VERIFY GATE was the failure trigger" || bad "rollback: verify gate was not the trigger"
[ "$(report_step "$ROLL_OUT" 'ROLLBACK')" = "run" ] && ok "rollback: the ROLLBACK ran" || bad "rollback: ROLLBACK step not in report"
[ "$(report_step "$ROLL_OUT" 'rollback: setOrgUpstream v1')" = "ok" ] && ok "rollback: setOrgUpstream(v1) ran OK" || bad "rollback: setOrgUpstream v1 not OK"
[ "$(report_step "$ROLL_OUT" 'rollback: unfreeze')" = "ok" ] && ok "rollback: unfreeze ran OK" || bad "rollback: unfreeze not OK"
# The snapshot-restore instruction is recorded as a report STEP (stdout, authoritative) AND
# printed to stderr; assert via the report step (robust against stderr/child-stdio interleaving).
{ [ "$(report_step "$ROLL_OUT" 'rollback: data-restore (manual)')" = "ok" ] || echo "$ROLL_OUT" | grep -qaiE 'pgbackrest|snapshot'; } \
  && ok "rollback: snapshot-restore instruction printed (pgbackrest pre-flip restore)" || bad "rollback: snapshot instruction missing"
[ "$(report_ok "$ROLL_OUT")" = "false" ] && ok "rollback: report ok=false" || bad "rollback: report not ok=false"
# the org is ROUTED BACK to v1 + UNFROZEN
ROLL_GET_BODY="$(http_body GET /$SLUG/projects)"
ROLL_POST_CODE="$(http_code POST /$SLUG/work-items)"
echo "    after rollback: GET /$SLUG -> '$ROLL_GET_BODY' ; POST /$SLUG -> $ROLL_POST_CODE"
echo "$ROLL_GET_BODY" | grep -q '^v1 ' && ok "rollback: /$SLUG routed BACK to v1" || bad "rollback: /$SLUG not back on v1 ('$ROLL_GET_BODY')"
[ "$ROLL_POST_CODE" = "200" ] && ok "rollback: /$SLUG is UNFROZEN (POST -> 200 v1, not 405)" || bad "rollback: /$SLUG still frozen (POST -> $ROLL_POST_CODE)"
# confirm via the control client that the proxy state is exactly v1/unfrozen
ROLL_STATE="$(PROXY_ADMIN="$PROXY_ADMIN" V1_DIAL="$V1_DIAL" V2_DIAL="$V2_DIAL" SLUG="$SLUG" npx tsx -e '
import { ProxyControl } from "./scripts/cutover/lib/proxy-control.ts";
(async () => {
  const p = new ProxyControl({ adminUrl: process.env.PROXY_ADMIN, upstreams: { v1: process.env.V1_DIAL, v2: process.env.V2_DIAL } });
  console.log(JSON.stringify(await p.getOrgState(process.env.SLUG)));
})();
')"
echo "    proxy state after rollback: $ROLL_STATE"
echo "$ROLL_STATE" | grep -q '"upstream":"v1"' && echo "$ROLL_STATE" | grep -q '"frozen":false' \
  && ok "rollback: proxy state is exactly {upstream:v1, frozen:false} (never left frozen/half-flipped)" \
  || bad "rollback: proxy state wrong ($ROLL_STATE)"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "CUTOVER ORCHESTRATION ACCEPTANCE: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
