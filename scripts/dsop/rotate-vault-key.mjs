#!/usr/bin/env node
// rotate-vault-key.mjs — IA-5 / SC 3.13.10 VAULT-KEY RE-WRAP (DEK migration).
//
// Re-wraps every vault-sealed secret to the keyring's ACTIVE kid so an old key can
// be RETIRED without losing access to any secret. This is the engineering half of a
// rotate-then-retire cycle:
//   1. operator adds the new key to SSO_VAULT_KEYS (ring now holds {old, new}) and
//      sets SSO_VAULT_ACTIVE_KID=new, then does a rolling restart (overlap window);
//   2. THIS SCRIPT re-wraps every sealed secret old→new (open under old, re-seal under new);
//   3. `--check` confirms 0 secrets remain on a non-active kid;
//   4. operator drops the old key from the ring and restarts — the old key is retired.
// See docs/runbooks/secret-rotation.md for the full procedure + rollback.
//
// ── The .mjs-vs-TS vault-import decision (single source of truth) ──
// The keyring seal/open/re-wrap logic lives in TypeScript at src/lib/crypto/vault.ts and
// is the SAME code the running app uses (src/lib/auth/sso.ts opens the OIDC client secret
// through it). For gov crypto correctness we MUST NOT fork that logic into a hand-rolled
// .mjs copy that could silently drift from the app's envelope format. So this script imports
// the vault TS DIRECTLY and is run under `tsx` (which lets an .mjs import a .ts) — exactly
// how docs/sso-acceptance/seed.ts already imports + uses the vault. The compose one-shot and
// the runbook invoke it as: `node_modules/.bin/tsx scripts/dsop/rotate-vault-key.mjs`.
// (pg is used directly for DB access, mirroring scripts/audit-worm-export.mjs.)
//
// ── Least privilege ──
// Connects via DATABASE_URL as the non-owner cosmos_app role, which has UPDATE on
// idp_connections + connector_credentials. It does NOT need (and must not use) the
// owner role: re-wrap is a plain SELECT + UPDATE on app tables, not DDL. (In compose,
// DATABASE_URL already points at cosmos_app.)
//
// ── Scope ──
// The vault-sealed columns are idp_connections.client_secret_enc (OIDC client secrets)
// and connector_credentials.secret_enc (connector-layer external creds — Google OAuth
// refresh tokens first). Both reuse the SAME keyring, so one re-wrap pass covers both —
// see SEALED_COLUMNS below.
//
// Env:
//   DATABASE_URL          cosmos_app creds (SELECT + UPDATE on idp_connections).
//   SSO_VAULT_KEYS        JSON keyring {kid: base64key} (must contain the active kid AND
//                         every kid that any stored secret is currently sealed under).
//   SSO_VAULT_ACTIVE_KID  the kid to re-wrap everything to.
//   (Backward-compat: SSO_VAULT_KEY alone => ring {v1:<key>}, active v1 — then re-wrap is a
//    no-op for everything, which is correct: nothing to migrate in single-key mode.)
//
// Flags:
//   --check   Report-only (NO writes). Counts secrets sealed under a non-active kid and
//             exits NON-ZERO if any remain — a CI / pre-retire gate for rotation completeness.
//
// Output: a JSON summary line {scanned, rewrapped, alreadyActive} on stdout.

import pg from "pg";
import {
  rewrapSecret,
  activeKid,
  kidOf,
} from "../../src/lib/crypto/vault.ts";

const CHECK_ONLY = process.argv.includes("--check");

// Every vault-sealed column the re-wrap must cover. Each entry: a table, its PK column,
// and the sealed column. Both reuse the SAME vault keyring, so one pass migrates them all.
//   - idp_connections.client_secret_enc   — per-tenant OIDC RP client secret (SSO).
//   - connector_credentials.secret_enc     — connector-layer external credentials
//                                            (Google OAuth refresh tokens first); the
//                                            connector-layer TODO is now closed.
const SEALED_COLUMNS = [
  { table: "idp_connections", pk: "id", column: "client_secret_enc" },
  { table: "connector_credentials", pk: "id", column: "secret_enc" },
];

function reqEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`rotate-vault-key: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

async function rotateColumn(client, { table, pk, column }, active, summary) {
  // SELECT every sealed value. Re-wrap is per-row and order-independent.
  const { rows } = await client.query(
    `SELECT ${pk} AS pk, ${column} AS sealed FROM ${table} WHERE ${column} IS NOT NULL`,
  );

  for (const row of rows) {
    summary.scanned++;
    let currentKid;
    try {
      currentKid = kidOf(row.sealed);
    } catch (err) {
      // A malformed/unknown blob is a hard error — never silently skip a secret.
      console.error(
        `rotate-vault-key: ${table}.${column} pk=${row.pk} has an unreadable sealed value: ${err?.message}`,
      );
      process.exit(1);
    }

    if (currentKid === active) {
      summary.alreadyActive++;
      continue;
    }

    // Non-active kid → needs migration.
    summary.nonActive.push({ table, column, pk: row.pk, kid: currentKid });

    if (CHECK_ONLY) continue; // report-only: don't open or write

    // Open under its current kid (must be in the ring) and re-seal under the active kid.
    const { sealed, changed } = rewrapSecret(row.sealed);
    if (!changed) {
      // Defensive: kidOf said non-active but rewrap reported no change — treat as already active.
      summary.alreadyActive++;
      continue;
    }
    await client.query(
      `UPDATE ${table} SET ${column} = $1 WHERE ${pk} = $2`,
      [sealed, row.pk],
    );
    summary.rewrapped++;
  }
}

async function main() {
  const DATABASE_URL = reqEnv("DATABASE_URL");
  // activeKid() also validates the keyring env (throws loudly if misconfigured) before we touch the DB.
  const active = activeKid();

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const summary = {
    activeKid: active,
    mode: CHECK_ONLY ? "check" : "rewrap",
    scanned: 0,
    rewrapped: 0,
    alreadyActive: 0,
    nonActive: [], // [{table, column, pk, kid}] — secrets NOT yet on the active kid
  };

  try {
    for (const col of SEALED_COLUMNS) {
      await rotateColumn(client, col, active, summary);
    }
  } catch (err) {
    await client.end();
    console.error(
      `rotate-vault-key: failed (${err?.name ?? "error"}): ${err?.message}`,
    );
    process.exit(1);
  }
  await client.end();

  const remaining = summary.nonActive.length;

  // Human-readable lines to stderr; the machine-readable summary to stdout.
  console.error(
    `rotate-vault-key[${summary.mode}]: active kid="${active}" — ` +
      `scanned ${summary.scanned}, rewrapped ${summary.rewrapped}, alreadyActive ${summary.alreadyActive}, ` +
      `onNonActiveKid ${remaining}.`,
  );
  if (remaining > 0) {
    for (const s of summary.nonActive) {
      console.error(
        `  - ${s.table}.${s.column} pk=${s.pk} is on kid "${s.kid}" (not the active "${active}")`,
      );
    }
  }

  console.log(
    JSON.stringify({
      activeKid: summary.activeKid,
      mode: summary.mode,
      scanned: summary.scanned,
      rewrapped: summary.rewrapped,
      alreadyActive: summary.alreadyActive,
      onNonActiveKid: remaining,
    }),
  );

  // --check is a rotation-completeness GATE: non-zero exit if ANY secret is still on a
  // non-active kid (so CI / the runbook can block retiring the old key until re-wrap is done).
  if (CHECK_ONLY && remaining > 0) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`rotate-vault-key: unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
