#!/usr/bin/env node
// scripts/cutover/acceptance/seed-google-creds.mjs — TEST SEED for the revoke acceptance.
//
// Creates a MINIMAL connector_credentials table (+ a tiny organizations FK target) in a
// throwaway target DB and inserts a couple of PER-USER sealed Google refresh-token creds,
// sealed with the REAL vault (src/lib/crypto/vault.ts) so the revoke CLI's openSecret can
// open them. Also inserts one org-LEVEL (user_id NULL) google cred + one OTHER-org cred to
// prove org-scoping (the revoke only touches per-user creds in the target org).
//
// Env: TARGET_DATABASE_URL, SSO_VAULT_KEY (or keyring). BUILD/TEST ONLY.

import pg from "pg";
import { sealSecret } from "../../../src/lib/crypto/vault.ts";

function reqEnv(n) {
  const v = process.env[n];
  if (!v) {
    console.error(`seed-google-creds: missing env ${n}`);
    process.exit(1);
  }
  return v;
}

const ORG = "11111111-1111-1111-1111-111111111111"; // the org we revoke
const OTHER_ORG = "22222222-2222-2222-2222-222222222222"; // a different org (must be untouched)
const USER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_B = "aaaaaaaa-0000-0000-0000-000000000002";
const OTHER_USER = "bbbbbbbb-0000-0000-0000-000000000001";

async function main() {
  const url = reqEnv("TARGET_DATABASE_URL");
  sealSecret("__probe__"); // validate the keyring before touching the DB

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Minimal FK target + the credentials table (subset of the real schema's columns).
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS connector_credentials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider text NOT NULL,
        user_id uuid,
        secret_enc text NOT NULL,
        meta jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query(`TRUNCATE connector_credentials`);
    await client.query(`INSERT INTO organizations (id) VALUES ($1),($2) ON CONFLICT DO NOTHING`, [ORG, OTHER_ORG]);

    const seal = (refreshToken) => sealSecret(JSON.stringify({ refreshToken }));

    const rows = [
      // Two per-user google creds in the target org — these get revoked.
      { org: ORG, user: USER_A, provider: "google", token: "1//token-user-a-secret" },
      { org: ORG, user: USER_B, provider: "google", token: "1//token-user-b-secret" },
      // An org-LEVEL google cred (user_id NULL) in the target org — NOT a per-user grant; skipped.
      { org: ORG, user: null, provider: "google", token: "1//token-orglevel-secret" },
      // A google cred in ANOTHER org — must be untouched (org-scoping).
      { org: OTHER_ORG, user: OTHER_USER, provider: "google", token: "1//token-other-org-secret" },
      // A non-google cred in the target org — must be untouched (provider-scoping).
      { org: ORG, user: USER_A, provider: "github", token: "ghp_should_not_be_revoked" },
    ];
    for (const r of rows) {
      await client.query(
        `INSERT INTO connector_credentials (org_id, provider, user_id, secret_enc) VALUES ($1,$2,$3,$4)`,
        [r.org, r.provider, r.user, seal(r.token)],
      );
    }
    console.log(
      JSON.stringify({
        org: ORG,
        otherOrg: OTHER_ORG,
        perUserGoogleInOrg: 2,
        orgLevelGoogleInOrg: 1,
        otherOrgGoogle: 1,
        nonGoogleInOrg: 1,
      }),
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`seed-google-creds: ${e?.stack ?? e}`);
  process.exit(1);
});
