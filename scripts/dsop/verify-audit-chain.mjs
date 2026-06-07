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
// ── Checkpoint sig verification (AU-11 retention-purge) ──
// The in-DB verify_audit_chain() anchors STRUCTURALLY at the latest checkpoint's row_hash
// when the genesis has been purged (migration 20260606130000_audit_retention_checkpoint) —
// it CANNOT verify the checkpoint's HMAC signature because a SQL function can't read the key
// from env. So this wrapper ALSO recomputes the latest checkpoint's HMAC and rejects a forged
// checkpoint (an attacker who re-anchored a tampered chain by inserting a bogus checkpoint).
// The sig is HMAC_sha256(key, tableName + String(checkpointSeq) + hex(checkpointRowHash)) —
// the EXACT canonical input scripts/dsop/purge-audit.mjs signs with. The key defaults to
// WORM_MANIFEST_HMAC_KEY (override with --hmac-key-env <NAME>, matching the purge script).
// If a table has NO checkpoint, there is nothing to sig-check (genesis-anchored) — fine.
//
// ── Least privilege ──
// Connects via DATABASE_URL as the non-owner cosmos_app role. Verification is SELECT-only
// (verify_audit_chain is STABLE and reads the same tables cosmos_app already has SELECT on,
// plus the checkpoint table SELECT + EXECUTE which are granted in the migrations). It does
// NOT need — and must not use — the owner role. In compose, the ops one-shot's DATABASE_URL
// points at cosmos_app.
//
// Env:
//   DATABASE_URL              cosmos_app creds (SELECT on the audit + checkpoint tables +
//                             EXECUTE on verify_audit_chain).
//   <hmac key env>            the checkpoint HMAC key (default WORM_MANIFEST_HMAC_KEY). REQUIRED
//                             only if any table has a checkpoint to sig-check.
//
// Output: one human line per table to stderr; a machine-readable JSON summary to stdout.
// Exit:   0 = both chains intact (incl. valid checkpoint sigs); 1 = a connection/SQL error;
//         2 = at least one chain broken OR a checkpoint sig is invalid (forged checkpoint).

import { createHmac, timingSafeEqual } from "node:crypto";
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

function parseArgs(argv) {
  const args = { hmacKeyEnv: "WORM_MANIFEST_HMAC_KEY" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--hmac-key-env") {
      const v = argv[++i];
      if (v === undefined) { console.error("verify-audit-chain: missing value for --hmac-key-env"); process.exit(1); }
      args.hmacKeyEnv = v;
    } else {
      console.error(`verify-audit-chain: unknown arg ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

// Recompute the canonical checkpoint sig — MUST match purge-audit.mjs signCheckpoint().
function expectedSig(key, tableName, checkpointSeq, rowHashHex) {
  return createHmac("sha256", key)
    .update(`${tableName}${String(checkpointSeq)}${rowHashHex}`)
    .digest();
}

function sigEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const DATABASE_URL = reqEnv("DATABASE_URL");
  const hmacKey = process.env[args.hmacKeyEnv]; // may be undefined if no checkpoints exist
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const results = []; // [{ table, intact, breaks, checkpoint: { seq, sigValid } | null }]
  try {
    for (const table of TABLES) {
      // 1. Structural chain walk (the in-DB function; checkpoint-aware anchor).
      const { rows } = await client.query(
        "SELECT broken_seq, reason FROM verify_audit_chain($1::regclass)",
        [table],
      );
      const breaks = rows.map((r) => ({
        // broken_seq is BIGINT -> string from pg; may be NULL for structural breaks.
        brokenSeq: r.broken_seq === null ? null : String(r.broken_seq),
        reason: r.reason,
      }));

      // 2. Checkpoint sig check (AU-11). The LATEST checkpoint per table is the active anchor;
      //    recompute its HMAC and compare. No checkpoint => nothing to sig-check.
      const { rows: cpRows } = await client.query(
        `SELECT checkpoint_seq, encode(checkpoint_row_hash, 'hex') AS row_hash_hex, sig
           FROM "audit_chain_checkpoint"
           WHERE table_name = $1
           ORDER BY checkpoint_seq DESC
           LIMIT 1`,
        [table],
      );
      let checkpoint = null;
      if (cpRows.length > 0) {
        const cp = cpRows[0];
        const seq = String(cp.checkpoint_seq);
        if (!hmacKey) {
          // A checkpoint exists but we have no key to verify its sig — fail closed.
          checkpoint = { seq, sigValid: false, reason: `no HMAC key (set ${args.hmacKeyEnv}) to verify checkpoint sig` };
          breaks.push({ brokenSeq: seq, reason: `checkpoint sig UNVERIFIABLE: missing key env ${args.hmacKeyEnv}` });
        } else {
          const want = expectedSig(hmacKey, table, seq, cp.row_hash_hex);
          // sig column is BYTEA -> Buffer from pg.
          const got = Buffer.isBuffer(cp.sig) ? cp.sig : Buffer.from(cp.sig);
          const ok = sigEqual(want, got);
          checkpoint = { seq, sigValid: ok };
          if (!ok) {
            breaks.push({ brokenSeq: seq, reason: "checkpoint sig INVALID (forged/altered checkpoint)" });
          }
        }
      }

      results.push({ table, intact: breaks.length === 0, breaks, checkpoint });
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
    const cpNote = r.checkpoint
      ? ` [checkpoint seq=${r.checkpoint.seq} sig=${r.checkpoint.sigValid ? "VALID" : "INVALID"}]`
      : " [no checkpoint — genesis-anchored]";
    if (r.intact) {
      console.error(`verify-audit-chain: ${r.table} — INTACT (hash-chain verified end to end).${cpNote}`);
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

  // Tamper-evidence GATE: non-zero so CI / ops / a scheduler can alarm on a break or a
  // forged/unverifiable checkpoint sig.
  if (anyBroken) process.exit(2);
}

main().catch((err) => {
  console.error(`verify-audit-chain: unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
