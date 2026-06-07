#!/usr/bin/env node
// scripts/cutover/revoke-google-tokens.mjs — PROVIDER-SIDE GOOGLE TOKEN REVOKE (cutover §9.3-5).
//
//   npx tsx scripts/cutover/revoke-google-tokens.mjs \
//     --target <TARGET_DATABASE_URL> --org <orgId-uuid> \
//     [--confirm]              (DEFAULT dry-run: list what WOULD be revoked, call nothing) \
//     [--fetch-impl test]      (use the in-boundary FAKE Google endpoint; tests NEVER hit Google) \
//     [--fake-google-state <p>](test fetch only: persist the already-revoked set across runs)
//
// WHY: the cutover is COPY-not-move. A migrated Google OAuth refresh token stays LIVE at
// Google after the flip — v1 keeps it as a rollback target during soak. Once the flip is
// PERMANENT, the copied token must be revoked at the PROVIDER so it cannot be used from the
// decommissioned v1. This script revokes, per user in the org, the sealed Google refresh
// token via Google's revoke endpoint.
//
//   POST https://oauth2.googleapis.com/revoke?token=<refreshToken>
//
// IDEMPOTENT: an already-revoked token returns 400 invalid_token ⇒ treated as already-done
// (success). DRY-RUN is the DEFAULT (lists targets, calls nothing); --confirm executes.
//
// ── RUN POST-FLIP ONLY ──────────────────────────────────────────────────────────────────
// Run this AFTER a permanent flip + finalize — NEVER during soak (v1 still needs the token as
// a rollback target). A rollback PAST this revoke requires the user to RE-CONSENT (the token
// is gone at Google). See docs/runbooks/cutover.md §7.
//
// SECRET HYGIENE: the refresh token is opened in-boundary, used for the one revoke call, and
// NEVER logged, printed, or written anywhere. The per-token report keys on user_id only.
//
// BUILD + SYNTHETIC-TEST ONLY: never point --target at real prod or use the real fetch path
// against real Google without the runbook + sign-off + live coordination. The acceptance uses
// --fetch-impl test exclusively.

import pg from "pg";
import { openSecret } from "../../src/lib/crypto/vault.ts";
import { revokeOneToken, isRevokeSuccess } from "./lib/revoke-core.ts";
import { makeFakeGoogleFetch } from "./lib/revoke-fake-google.ts";

const GOOGLE_PROVIDER = "google";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const out = { confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--fetch-impl") out.fetchImpl = argv[++i];
    else if (a === "--fake-google-state") out.fakeState = argv[++i];
    else fail(`unknown arg ${a}`);
  }
  return out;
}

function fail(msg, code = 2) {
  console.error(`revoke-google-tokens: ${msg}`);
  process.exit(code);
}

/**
 * Resolve the fetch implementation. DEFAULT is the real global fetch (the live provider
 * path). `--fetch-impl test` selects the in-boundary FAKE endpoint — the ONLY path the
 * synthetic acceptance/tests use, so they never hit real Google.
 */
function resolveFetch(args) {
  if (args.fetchImpl === "test") {
    return { impl: makeFakeGoogleFetch(args.fakeState), label: "TEST (fake in-boundary Google)" };
  }
  if (args.fetchImpl && args.fetchImpl !== "real") {
    fail(`--fetch-impl must be "test" or "real" (got "${args.fetchImpl}")`);
  }
  if (typeof fetch !== "function") fail("global fetch is unavailable in this runtime");
  // Adapt the global fetch to the FetchLike contract revokeOneToken expects.
  return {
    impl: async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, text: () => r.text() };
    },
    label: "REAL (https://oauth2.googleapis.com/revoke)",
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const target = args.target ?? fail("missing required --target");
  const org = args.org ?? fail("missing required --org");
  if (!UUID_RE.test(org)) fail(`--org ${org} is not a UUID`);
  const confirm = args.confirm;
  const { impl: fetchImpl, label: fetchLabel } = resolveFetch(args);

  console.error("══════════════════════════════════════════════════════════════════════");
  console.error("  COSMOS v2 — PROVIDER-SIDE GOOGLE TOKEN REVOKE (post-flip, §9.3-5)");
  console.error(`  org ${org}`);
  console.error(`  MODE: ${confirm ? "CONFIRM (will call the revoke endpoint)" : "DRY-RUN (default — calls NOTHING)"}`);
  console.error(`  fetch: ${confirm ? fetchLabel : "(dry-run — not used)"}`);
  console.error("  RUN POST-FLIP ONLY. Never log the token. Idempotent.");
  console.error("══════════════════════════════════════════════════════════════════════");

  const client = new pg.Client({ connectionString: target });
  await client.connect();

  const report = [];
  const summary = { scanned: 0, revoked: 0, alreadyRevoked: 0, failed: 0, dryRun: !confirm };

  try {
    // Per-USER google credentials in THIS org (user_id NOT NULL — the user's own OAuth grant).
    const { rows } = await client.query(
      `SELECT id, user_id, secret_enc FROM connector_credentials
        WHERE org_id = $1 AND provider = $2 AND user_id IS NOT NULL
        ORDER BY user_id ASC`,
      [org, GOOGLE_PROVIDER],
    );
    summary.scanned = rows.length;

    for (const row of rows) {
      const userId = row.user_id;

      if (!confirm) {
        // DRY-RUN: report the target WITHOUT opening the secret or calling anything.
        console.error(`  [dry-run] would revoke google token for user ${userId}`);
        report.push({ userId, action: "would-revoke", status: "dry-run" });
        continue;
      }

      // Open the sealed bundle in-boundary to get the refresh token. NEVER log it.
      let refreshToken;
      try {
        const bundle = JSON.parse(openSecret(row.secret_enc));
        refreshToken = bundle?.refreshToken ?? bundle?.refresh_token;
      } catch (e) {
        summary.failed++;
        const detail = e instanceof Error ? e.message : String(e);
        console.error(`  ✗ user ${userId}: could not open sealed credential — ${detail}`);
        report.push({ userId, action: "revoke", status: "failed", httpStatus: 0, detail });
        continue;
      }

      const result = await revokeOneToken(refreshToken, fetchImpl);
      if (result.status === "revoked") summary.revoked++;
      else if (result.status === "already-revoked") summary.alreadyRevoked++;
      else summary.failed++;

      const icon = isRevokeSuccess(result) ? "✓" : "✗";
      // The report/log NEVER contains the token — only userId, status, http code, non-secret detail.
      console.error(
        `  ${icon} user ${userId}: ${result.status}` +
          (result.httpStatus ? ` (HTTP ${result.httpStatus})` : "") +
          (result.detail ? ` — ${result.detail}` : ""),
      );
      report.push({ userId, action: "revoke", status: result.status, httpStatus: result.httpStatus, detail: result.detail });
    }
  } catch (err) {
    await client.end();
    fail(`failed: ${err?.message ?? err}`, 1);
  }
  await client.end();

  console.error(
    `revoke-google-tokens: scanned ${summary.scanned}, revoked ${summary.revoked}, ` +
      `already-revoked ${summary.alreadyRevoked}, failed ${summary.failed}` +
      (summary.dryRun ? " (DRY-RUN — nothing called)" : ""),
  );

  // Machine-readable summary + per-token report (stdout). NO token anywhere in it.
  console.log(JSON.stringify({ ...summary, report }));

  // Non-zero exit if any real (non-dry-run) revoke FAILED — the caller can retry.
  if (confirm && summary.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`revoke-google-tokens: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
