#!/usr/bin/env bash
# scripts/cutover/acceptance/run-gov-gate-revoke-acceptance.sh
#
# SYNTHETIC ACCEPTANCE for the two cutover finishers:
#   (1) the GOV EXPOSABILITY-MAP SIGN-OFF GATE, and
#   (2) the PROVIDER-SIDE GOOGLE-TOKEN REVOKE.
#
# Proves, end to end (NO prod, NO real Google):
#   A. SNAPSHOT  — exposability-snapshot.mjs writes JSON+markdown+hash; a re-run ⇒ identical
#                  hash (stable).
#   B. GATE      — requireExposabilitySignoff: gov w/ a matching-hash + leak-passed sign-off
#                  ⇒ PASS; gov w/ a STALE hash ⇒ FAIL; gov w/o a file ⇒ FAIL; commercial ⇒
#                  PASS with no sign-off.
#   C. ORCHESTRATOR — dry-run reports a gov flip BLOCKED without a valid sign-off and ALLOWED
#                  with one (commercial: gate N/A).
#   D. REVOKE    — seed sealed per-user google creds in a throwaway target DB; the revoke CLI
#                  with --fetch-impl test (FAKE Google) revokes each token, is IDEMPOTENT on a
#                  re-run (already-revoked), the dry-run default touches NOTHING, only per-user
#                  google creds in the target org are touched (org/provider scoping), and NO
#                  token is ever logged.
#
# Requires sudo docker. FREE host port: target PG 55470.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

D="sudo docker"
PG_IMAGE=pgvector/pgvector:pg16
TGT_NAME=govgate-acc-tgt
TGT_PORT=55470
TGT="postgres://cosmos:cosmos@localhost:${TGT_PORT}/cosmos"

WORKDIR="$(mktemp -d /tmp/govgate-acc.XXXXXX)"
SNAP1="$WORKDIR/snap1"
SNAP2="$WORKDIR/snap2"
SIGNOFF_DIR="$REPO/compliance/exposability/signoff"
FAKE_GOOGLE_STATE="$WORKDIR/fake-google.json"

# A throwaway vault key for sealing the seeded creds + opening them in the revoke CLI.
export SSO_VAULT_KEY="$(openssl rand -base64 32)"

ORG="11111111-1111-1111-1111-111111111111"          # the revoke target org (matches the seed)
GOV_SLUG="govgate-acc-org"                            # a gov tenant slug for the gate tests
COMM_SLUG="commgate-acc-org"                          # a commercial tenant slug
FAKE_DUMP="$WORKDIR/fake-schema.sql"                  # the orchestrator's --prod-schema-dump existsSync check

PASS=0
FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

cleanup() {
  echo "── teardown ──"
  $D rm -f "$TGT_NAME" >/dev/null 2>&1
  rm -f "$SIGNOFF_DIR/$GOV_SLUG.json"
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "══════════════════════════════════════════════════════════════════════"
echo "  GOV EXPOSABILITY GATE + GOOGLE TOKEN REVOKE — SYNTHETIC ACCEPTANCE"
echo "  (no prod, no real Google; --fetch-impl test only)"
echo "══════════════════════════════════════════════════════════════════════"

touch "$FAKE_DUMP"

# ─────────────────────────────────────────────────────────────────────────────
# A. SNAPSHOT — stable hash
# ─────────────────────────────────────────────────────────────────────────────
echo "── A. exposability snapshot + stable hash ──"
npx tsx scripts/cutover/exposability-snapshot.mjs --out "$SNAP1" --quiet >/dev/null 2>&1
npx tsx scripts/cutover/exposability-snapshot.mjs --out "$SNAP2" --quiet >/dev/null 2>&1
HASH1="$(cat "$SNAP1/exposability-map.hash")"
HASH2="$(cat "$SNAP2/exposability-map.hash")"
if [ -f "$SNAP1/exposability-map.json" ] && [ -f "$SNAP1/exposability-map.md" ] && [ -n "$HASH1" ]; then
  ok "snapshot wrote JSON + markdown + hash ($HASH1)"
else
  bad "snapshot did not write the expected artifacts"
fi
if [ "$HASH1" = "$HASH2" ]; then ok "hash STABLE across re-runs ($HASH1)"; else bad "hash unstable: $HASH1 != $HASH2"; fi
CURHASH="$HASH1"

# ─────────────────────────────────────────────────────────────────────────────
# B. GATE — pass / stale-fail / missing-fail / commercial-pass (pure, via tsx)
# ─────────────────────────────────────────────────────────────────────────────
echo "── B. requireExposabilitySignoff (4 cases) ──"
gate() { # args: orgSlug tenantClass mapHashInLoader|none
  node_modules/.bin/tsx -e "
    import { requireExposabilitySignoff, exposabilityHash } from '$REPO/scripts/cutover/lib/exposability.ts';
    const want = '$3';
    const load = () => want === 'none' ? null : { orgSlug: '$1', mapHash: want === 'live' ? exposabilityHash() : want, reviewer: 'sec', signedAt: '2026-06-07T00:00:00Z', leakTestPassed: true };
    const r = requireExposabilitySignoff('$1', '$2', load);
    console.log(r.ok ? 'PASS' : 'FAIL');
  "
}
[ "$(gate "$GOV_SLUG" gov live)" = "PASS" ]        && ok "gov + matching-hash + leak-passed ⇒ PASS"        || bad "gov matching-hash did not PASS"
[ "$(gate "$GOV_SLUG" gov deadbeef)" = "FAIL" ]    && ok "gov + STALE hash ⇒ FAIL"                          || bad "gov stale-hash did not FAIL"
[ "$(gate "$GOV_SLUG" gov none)" = "FAIL" ]        && ok "gov + NO sign-off ⇒ FAIL"                         || bad "gov missing did not FAIL"
[ "$(gate "$COMM_SLUG" commercial none)" = "PASS" ]&& ok "commercial + no sign-off ⇒ PASS"                  || bad "commercial did not PASS"

# ─────────────────────────────────────────────────────────────────────────────
# C. ORCHESTRATOR dry-run — gov BLOCKED without / ALLOWED with a sign-off
# ─────────────────────────────────────────────────────────────────────────────
echo "── C. orchestrator dry-run gov gate (blocked / allowed) ──"
ORCH_COMMON=( scripts/cutover/orchestrate.mjs --org "$ORG" --source x --target y --scratch s --shadow sh \
  --prod-schema-dump "$FAKE_DUMP" --state "$WORKDIR/st.json" --proxy-admin http://localhost:9 )

rm -f "$SIGNOFF_DIR/$GOV_SLUG.json"
OUT_BLOCK="$(npx tsx "${ORCH_COMMON[@]}" --slug "$GOV_SLUG" --tenant-class gov 2>&1)"
echo "$OUT_BLOCK" | grep -q "BLOCKED" && ok "gov dry-run BLOCKED without a sign-off" || bad "gov dry-run not BLOCKED"

# Write a valid sign-off at the current hash, then re-run ⇒ ALLOWED.
cat > "$SIGNOFF_DIR/$GOV_SLUG.json" <<EOF
{"orgSlug":"$GOV_SLUG","mapHash":"$CURHASH","reviewer":"secadmin","signedAt":"2026-06-07T00:00:00Z","leakTestPassed":true}
EOF
OUT_ALLOW="$(npx tsx "${ORCH_COMMON[@]}" --slug "$GOV_SLUG" --tenant-class gov 2>&1)"
echo "$OUT_ALLOW" | grep -q "ALLOWED" && ok "gov dry-run ALLOWED with a valid sign-off" || bad "gov dry-run not ALLOWED"

OUT_COMM="$(npx tsx "${ORCH_COMMON[@]}" --slug "$COMM_SLUG" --tenant-class commercial 2>&1)"
echo "$OUT_COMM" | grep -q "N/A (commercial" && ok "commercial dry-run: gate N/A (unaffected)" || bad "commercial gate not N/A"

# A stale sign-off (tamper the hash) ⇒ orchestrator BLOCKED again.
cat > "$SIGNOFF_DIR/$GOV_SLUG.json" <<EOF
{"orgSlug":"$GOV_SLUG","mapHash":"deadbeef","reviewer":"secadmin","signedAt":"2026-06-07T00:00:00Z","leakTestPassed":true}
EOF
OUT_STALE="$(npx tsx "${ORCH_COMMON[@]}" --slug "$GOV_SLUG" --tenant-class gov 2>&1)"
echo "$OUT_STALE" | grep -q "STALE sign-off" && ok "gov dry-run BLOCKED on a STALE sign-off" || bad "stale sign-off not BLOCKED"
rm -f "$SIGNOFF_DIR/$GOV_SLUG.json"

# ─────────────────────────────────────────────────────────────────────────────
# D. REVOKE — seeded sealed google creds, fake Google, idempotent, dry-run no-op, no token logged
# ─────────────────────────────────────────────────────────────────────────────
echo "── D. provider-side google-token revoke (fake Google) ──"
echo "  starting throwaway target PG ($TGT_NAME:$TGT_PORT)…"
$D rm -f "$TGT_NAME" >/dev/null 2>&1
$D run -d --name "$TGT_NAME" -e POSTGRES_USER=cosmos -e POSTGRES_PASSWORD=cosmos -e POSTGRES_DB=cosmos \
  -p "${TGT_PORT}:5432" "$PG_IMAGE" >/dev/null 2>&1
# wait for readiness
for i in $(seq 1 30); do
  if $D exec "$TGT_NAME" pg_isready -U cosmos -d cosmos >/dev/null 2>&1; then break; fi
  sleep 1
done

TARGET_DATABASE_URL="$TGT" npx tsx scripts/cutover/acceptance/seed-google-creds.mjs >"$WORKDIR/seed.out" 2>"$WORKDIR/seed.err"
if grep -q '"perUserGoogleInOrg":2' "$WORKDIR/seed.out"; then ok "seeded 2 per-user google creds (+ org-level + other-org + non-google decoys)"; else bad "seed failed: $(cat "$WORKDIR/seed.err")"; fi

# D.1 DRY-RUN (default) touches nothing.
DRY="$(npx tsx scripts/cutover/revoke-google-tokens.mjs --target "$TGT" --org "$ORG" 2>&1)"
DRY_JSON="$(echo "$DRY" | grep -E '^\{' | tail -1)"
echo "$DRY_JSON" | grep -q '"dryRun":true' && echo "$DRY_JSON" | grep -q '"revoked":0' \
  && ok "dry-run default: scanned but revoked 0 (touched nothing)" || bad "dry-run did not no-op: $DRY_JSON"

# D.2 CONFIRM with the FAKE Google endpoint → both tokens revoked.
RUN1="$(npx tsx scripts/cutover/revoke-google-tokens.mjs --target "$TGT" --org "$ORG" --confirm --fetch-impl test --fake-google-state "$FAKE_GOOGLE_STATE" 2>&1)"
RUN1_JSON="$(echo "$RUN1" | grep -E '^\{' | tail -1)"
echo "$RUN1_JSON" | grep -q '"scanned":2' && echo "$RUN1_JSON" | grep -q '"revoked":2' \
  && ok "confirm: both per-user google tokens REVOKED (scanned 2, revoked 2)" || bad "confirm did not revoke both: $RUN1_JSON"

# D.3 IDEMPOTENT re-run → already-revoked (the fake persists state across processes).
RUN2="$(npx tsx scripts/cutover/revoke-google-tokens.mjs --target "$TGT" --org "$ORG" --confirm --fetch-impl test --fake-google-state "$FAKE_GOOGLE_STATE" 2>&1)"
RUN2_JSON="$(echo "$RUN2" | grep -E '^\{' | tail -1)"
echo "$RUN2_JSON" | grep -q '"alreadyRevoked":2' && echo "$RUN2_JSON" | grep -q '"failed":0' \
  && ok "idempotent re-run: both already-revoked (failed 0)" || bad "re-run not idempotent: $RUN2_JSON"

# D.4 NO TOKEN LOGGED — the secret token plaintext must not appear in ANY output.
ALLOUT="$DRY
$RUN1
$RUN2"
if echo "$ALLOUT" | grep -q "token-user-a-secret\|token-user-b-secret\|1//token"; then
  bad "a refresh token LEAKED into the output!"
else
  ok "no refresh token appears in any revoke output"
fi

# D.5 ORG/PROVIDER SCOPING — the other-org google cred + the org-level + the github cred are untouched.
# (Run revoke for the OTHER org and confirm only its 1 per-user google cred is the scan target;
#  the github cred + org-level cred are never scanned because of the provider/user filters.)
RUN_OTHER="$(npx tsx scripts/cutover/revoke-google-tokens.mjs --target "$TGT" --org 22222222-2222-2222-2222-222222222222 --confirm --fetch-impl test --fake-google-state "$WORKDIR/fake-google-other.json" 2>&1)"
RUN_OTHER_JSON="$(echo "$RUN_OTHER" | grep -E '^\{' | tail -1)"
echo "$RUN_OTHER_JSON" | grep -q '"scanned":1' \
  && ok "org-scoping: other org scans only its 1 per-user google cred (org-level + github + first-org untouched)" \
  || bad "org scoping wrong: $RUN_OTHER_JSON"

echo "══════════════════════════════════════════════════════════════════════"
echo "  RESULT: PASS=$PASS  FAIL=$FAIL"
echo "══════════════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
