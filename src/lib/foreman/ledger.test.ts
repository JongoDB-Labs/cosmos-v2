import { describe, it, expect } from "vitest";
import { appendLedger, readLedger } from "./ledger";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ledger", () => {
  it("round-trips entries and returns [] for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const p = join(dir, "foreman-ledger.jsonl");
    expect(readLedger(p)).toEqual([]);
    appendLedger(p, { ticket: "COSMOS-1", title: "x", classification: "BUG", resolution: "shipped", version: "2.159.0", ts: "2026-07-07T00:00:00Z" });
    appendLedger(p, { ticket: "COSMOS-2", title: "y", classification: "FEATURE", resolution: "duplicate", dupOf: "COSMOS-1", ts: "2026-07-07T01:00:00Z" });
    const rows = readLedger(p);
    expect(rows).toHaveLength(2);
    expect(rows[0].version).toBe("2.159.0");
    expect(rows[1].dupOf).toBe("COSMOS-1");
  });
});
