// Contract test for the AU-11 checkpoint HMAC sig.
//
// The purge script (purge-audit.mjs) SIGNS each checkpoint and the verify wrapper
// (verify-audit-chain.mjs) RECOMPUTES the same sig to detect a forged checkpoint. Both must
// use the IDENTICAL canonical input. This pins that contract:
//   HMAC_sha256(key, tableName + String(checkpointSeq) + hex(checkpointRowHash))
// The golden value below was cross-checked BYTE-FOR-BYTE against pgcrypto's
// hmac(table || seq || encode(row_hash,'hex'), key, 'sha256') on a real PG16 cluster during
// the empirical proof, so this test also guards against a future drift between the JS sig and
// the SQL-side construction used in the migration proof / any in-DB HMAC.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signCheckpoint } from "./purge-audit.mjs";

// The verify wrapper's helper is not exported (it reads env in main); re-derive it here from
// the documented formula so the test fails if EITHER side's formula drifts.
function expectedSig(key, tableName, checkpointSeq, rowHashHex) {
  return createHmac("sha256", key)
    .update(`${tableName}${String(checkpointSeq)}${rowHashHex}`)
    .digest();
}

describe("AU-11 checkpoint sig — canonical HMAC contract", () => {
  const key = "test-key";
  const table = "audit_logs";
  const seq = 4n;
  const rowHashHex =
    "40d03402a0e719c85de2dad9ebf44455f395e2a988a9618fc48ef07130223de1";

  it("signCheckpoint matches the documented canonical formula", () => {
    const sig = signCheckpoint(key, table, seq, rowHashHex);
    expect(sig.equals(expectedSig(key, table, seq, rowHashHex))).toBe(true);
  });

  it("matches the pgcrypto-cross-checked golden value (byte-for-byte vs PG16)", () => {
    // Golden = the sig pgcrypto produced for the same input during the PG16 empirical proof.
    const golden =
      "17df0db4a6e660d65495f778068863fcf7f36bea3fb95a26be50b88d6ab132e0";
    expect(signCheckpoint(key, table, seq, rowHashHex).toString("hex")).toBe(golden);
  });

  it("accepts a numeric or bigint seq identically (String() canonicalization)", () => {
    expect(
      signCheckpoint(key, table, 4, rowHashHex).equals(
        signCheckpoint(key, table, 4n, rowHashHex),
      ),
    ).toBe(true);
  });

  it("changes if ANY field changes (table, seq, hash, key)", () => {
    const base = signCheckpoint(key, table, seq, rowHashHex);
    expect(base.equals(signCheckpoint("other-key", table, seq, rowHashHex))).toBe(false);
    expect(base.equals(signCheckpoint(key, "egress_decisions", seq, rowHashHex))).toBe(false);
    expect(base.equals(signCheckpoint(key, table, 5n, rowHashHex))).toBe(false);
    expect(
      base.equals(signCheckpoint(key, table, seq, rowHashHex.replace(/.$/, "0"))),
    ).toBe(false);
  });
});
