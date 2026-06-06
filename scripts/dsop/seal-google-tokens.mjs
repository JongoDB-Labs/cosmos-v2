#!/usr/bin/env node
// seal-google-tokens.mjs — PRE-DROP DRAIN of the legacy plaintext User.googleRefreshToken
// column into the sealed ConnectorCredential store (SC-28 / 800-171 3.13.16; IA-5).
//
// v2.7.0 made the sealed connector_credentials store the source of truth for Google OAuth
// refresh tokens, and getGoogleClientForUser self-heals any legacy plaintext token to sealed
// on first use. This script is the BULK pre-drop drain: it seals EVERY remaining non-null
// users.google_refresh_token into connector_credentials and NULLs the column, so the column
// can be safely DROPPED (migration 20260606120000_drop_google_refresh_token) WITHOUT losing
// any un-self-healed token.
//
// ── ORDERING (read docs/runbooks/secret-rotation.md) ──
//   On a NON-EMPTY instance: run THIS script BEFORE applying the drop-column migration.
//   The drop migration removes the read-path fallback's column; once removed, an
//   un-swept token is GONE (the fallback was removed from getGoogleClientForUser in the
//   same change). On a GREENFIELD instance this is a no-op (no rows) and ordering is moot.
//
// ── What it does, per user with a non-null token ──
//   1. resolve the user's PRIMARY org (earliest-joined membership) — the same org
//      getGoogleClientForUser/storeGoogleRefreshToken scope the token under;
//   2. seal {refreshToken} as a vault envelope and UPSERT it into connector_credentials
//      for (org, 'google', user) — honoring the per-user partial unique index;
//   3. NULL users.google_refresh_token only AFTER the sealed copy is durably written.
//   A user with a token but NO membership yet is SKIPPED (no org to scope under) and
//   reported — it will self-heal on first authenticated use once they have an org.
//
// Idempotent: a second run finds nothing to sweep (all columns NULL) → 0 swept. Re-running
// after a partial failure resumes cleanly (it only ever touches still-non-null rows).
//
// ── The vault-import decision (mirrors rotate-vault-key.mjs) ──
// Seals via the SAME TypeScript vault (src/lib/crypto/vault.ts) the app uses, imported
// directly and run under tsx — never a forked .mjs copy that could drift from the envelope
// format. The seal shape matches credentials.ts setCredential exactly:
//   secret_enc = sealSecret(JSON.stringify({ refreshToken })).
// Run as: node_modules/.bin/tsx scripts/dsop/seal-google-tokens.mjs
//
// ── Least privilege ──
// Connects via DATABASE_URL as the non-owner cosmos_app role (SELECT users; SELECT/UPDATE
// org_members read; INSERT/UPDATE connector_credentials; UPDATE users.google_refresh_token).
// All plain DML on app tables — no owner role, no DDL. The column DROP is a SEPARATE,
// owner-applied migration.
//
// Env:
//   DATABASE_URL          cosmos_app creds.
//   SSO_VAULT_KEYS / SSO_VAULT_ACTIVE_KID  (or legacy SSO_VAULT_KEY)  — the seal keyring.
//
// Output: a JSON summary {scanned, sealed, skippedNoOrg, alreadyNull} on stdout.

import pg from "pg";
import { sealSecret } from "../../src/lib/crypto/vault.ts";

const GOOGLE_PROVIDER = "google";

function reqEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`seal-google-tokens: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

/** Resolve the user's PRIMARY org (earliest joined) — the same scope the app uses. */
async function resolvePrimaryOrgId(client, userId) {
  const { rows } = await client.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1`,
    [userId],
  );
  return rows[0]?.org_id ?? null;
}

/** Upsert the sealed bundle into connector_credentials for (org, google, user). */
async function upsertSealedCredential(client, orgId, userId, secretEnc) {
  // Honor the per-user partial unique index (UNIQUE(org,provider,user) WHERE user_id NOT NULL):
  // findFirst-then-update-or-insert, mirroring credentials.ts setCredential.
  const { rows } = await client.query(
    `SELECT id FROM connector_credentials WHERE org_id = $1 AND provider = $2 AND user_id = $3 LIMIT 1`,
    [orgId, GOOGLE_PROVIDER, userId],
  );
  if (rows[0]) {
    await client.query(
      `UPDATE connector_credentials SET secret_enc = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [secretEnc, rows[0].id],
    );
  } else {
    await client.query(
      `INSERT INTO connector_credentials (org_id, provider, user_id, secret_enc, meta, updated_at)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, CURRENT_TIMESTAMP)`,
      [orgId, GOOGLE_PROVIDER, userId, secretEnc],
    );
  }
}

async function main() {
  const DATABASE_URL = reqEnv("DATABASE_URL");
  // Validate the keyring env (throws loudly if misconfigured) before touching the DB.
  sealSecret("__probe__");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const summary = { scanned: 0, sealed: 0, skippedNoOrg: 0, alreadyNull: 0, skippedUsers: [] };

  try {
    const { rows } = await client.query(
      `SELECT id, google_refresh_token AS token FROM users WHERE google_refresh_token IS NOT NULL`,
    );
    summary.scanned = rows.length;

    for (const row of rows) {
      const orgId = await resolvePrimaryOrgId(client, row.id);
      if (!orgId) {
        // No org to scope under yet — leave the token in place (it self-heals on first
        // authenticated use once the user has a membership). Report it.
        summary.skippedNoOrg++;
        summary.skippedUsers.push(row.id);
        continue;
      }
      // Seal {refreshToken} exactly as credentials.ts setCredential does.
      const secretEnc = sealSecret(JSON.stringify({ refreshToken: row.token }));
      await upsertSealedCredential(client, orgId, row.id, secretEnc);
      // NULL the plaintext column ONLY after the sealed copy is durably written.
      await client.query(`UPDATE users SET google_refresh_token = NULL WHERE id = $1`, [row.id]);
      summary.sealed++;
    }
  } catch (err) {
    await client.end();
    console.error(`seal-google-tokens: failed (${err?.name ?? "error"}): ${err?.message}`);
    process.exit(1);
  }
  await client.end();

  console.error(
    `seal-google-tokens: scanned ${summary.scanned}, sealed ${summary.sealed}, ` +
      `skippedNoOrg ${summary.skippedNoOrg}.`,
  );
  if (summary.skippedNoOrg > 0) {
    console.error(
      `  - ${summary.skippedNoOrg} token(s) left in place (no org membership yet); they self-heal on first use: ` +
        summary.skippedUsers.join(", "),
    );
    console.error(
      "  WARNING: do NOT drop users.google_refresh_token until these have drained, or those tokens are lost.",
    );
  }

  console.log(
    JSON.stringify({
      scanned: summary.scanned,
      sealed: summary.sealed,
      skippedNoOrg: summary.skippedNoOrg,
    }),
  );

  // Non-zero exit if any token couldn't be swept — a pre-drop gate (don't drop the column
  // while un-swept plaintext tokens remain).
  if (summary.skippedNoOrg > 0) process.exit(2);
}

main().catch((err) => {
  console.error(`seal-google-tokens: unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
