import { describe, it, expect } from "vitest";
import { ledgerCandidates } from "./dedup-ledger";

describe("ledgerCandidates", () => {
  it("keeps only resolved entries", () => {
    const c = ledgerCandidates([
      { ticket: "COSMOS-1", title: "A", classification: "BUG", resolution: "shipped", ts: "" },
      { ticket: "COSMOS-9", title: "B", classification: "BUG", resolution: "gated", ts: "" },
    ]);
    expect(c.map((x) => x.ref)).toEqual(["COSMOS-1", "COSMOS-9"]);
  });
});
