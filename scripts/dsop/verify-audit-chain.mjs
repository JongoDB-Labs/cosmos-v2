#!/usr/bin/env node
// verify-audit-chain.mjs — AU-9 in-DB tamper-EVIDENCE GATE.
//
// Calls the in-DB verify_audit_chain() function (installed by migration
// 20260606070000_audit_hash_chain) on BOTH append-only audit tables and reports whether
// each cryptographic hash-chain is intact. Any detected break — a post-hoc content edit,
// an inserted/forged row, a mid-chain deletion, a missing/duplicate genesis — makes this
// script exit NON-ZERO so CI / the ops one-shot / a scheduler can alarm on it.
//
// ── What the chain proves (and its limits) ──
// Each row's row_hash binds the PREVIOUS row's hash + this row's framed columns (sha256
// via pgcrypto). The chain is a LINKED LIST; verify_audit_chain walks it from genesis
// (prev_hash IS NULL) following prev_hash -> row_hash links, recomputing every hash. The
// append-only triggers (20260606050000) already BLOCK UPDATE/DELETE/TRUNCATE for everyone
// incl. the owner; this chain is the SECOND line of defense — it detects tampering that
// would only be possible by an attacker who first disabled those guards (owner/superuser).
// The OFFSITE anchor is scripts/audit-worm-export.mjs (object-locked WORM bucket). In-DB
// chain + offsite WORM = defense in depth. See docs/runbooks/audit-integrity.md.
//
// ── Least privilege ──
// Connects via DATABASE_URL as the non-owner cosmos_app role. Verification is SELECT-only
// (verify_audit_chain is STABLE and reads the same tables cosmos_app already has SELECT on,
// plus EXECUTE which is granted in the migration). It does NOT need — and must not use —
// the owner role. In compose, the ops one-shot's DATABASE_URL points at cosmos_app.
//
// Env:
//   DATABASE_URL   cosmos_app creds (SELECT on the audit tables + EXECUTE on verify_audit_chain).
//
// Output: one human line per table to stderr; a machine-readable JSON summary to stdout.
// Exit:   0 = both chains intact; 1 = a connection/SQL error; 2 = at least one chain broken.

import pg from "pg";

const TABLES = ["audit_logs", "egress_decisions"];

function reqEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`verify-audit-chain: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const DATABASE_URL = reqEnv("DATABASE_URL");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const results = []; // [{ table, intact, breaks: [{ brokenSeq, reason }] }]
  try {
    for (const table of TABLES) {
      // verify_audit_chain(regclass) returns 0 rows when intact, else the first break.
      const { rows } = await client.query(
        "SELECT broken_seq, reason FROM verify_audit_chain($1::regclass)",
        [table],
      );
      const breaks = rows.map((r) => ({
        // broken_seq is BIGINT -> string from pg; may be NULL for structural breaks.
        brokenSeq: r.broken_seq === null ? null : String(r.broken_seq),
        reason: r.reason,
      }));
      results.push({ table, intact: breaks.length === 0, breaks });
    }
  } catch (err) {
    await client.end();
    console.error(
      `verify-audit-chain: failed (${err?.name ?? "error"}): ${err?.message}`,
    );
    process.exit(1);
  }
  await client.end();

  let anyBroken = false;
  for (const r of results) {
    if (r.intact) {
      console.error(`verify-audit-chain: ${r.table} — INTACT (hash-chain verified end to end).`);
    } else {
      anyBroken = true;
      for (const b of r.breaks) {
        console.error(
          `verify-audit-chain: ${r.table} — BROKEN at seq=${b.brokenSeq ?? "<structural>"}: ${b.reason}`,
        );
      }
    }
  }

  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      tables: results,
      allIntact: !anyBroken,
    }),
  );

  // Tamper-evidence GATE: non-zero so CI / ops / a scheduler can alarm on a break.
  if (anyBroken) process.exit(2);
}

main().catch((err) => {
  console.error(`verify-audit-chain: unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
