import { describe, it, expect, vi } from "vitest";
import { dedupGate, ledgerCandidates } from "./dedup-gate";

describe("dedupGate", () => {
  it("returns unique with no prefilter matches (judge never called)", async () => {
    const judge = vi.fn();
    const r = await dedupGate({ title: "Add dark mode", candidates: [{ ref: "COSMOS-2", title: "Fix login crash" }] }, judge, 0.5);
    expect(r.dupOf).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });
  it("consults the judge only for prefiltered matches and returns its verdict", async () => {
    const judge = vi.fn().mockResolvedValue({ dupOf: "COSMOS-2", reason: "same work-role bug" });
    const r = await dedupGate(
      { title: "Failing to create work role", candidates: [{ ref: "COSMOS-2", title: "Cannot create work role" }] },
      judge,
      0.5,
    );
    expect(judge).toHaveBeenCalledOnce();
    expect(r.dupOf).toBe("COSMOS-2");
  });
  it("ledgerCandidates keeps only resolved entries", () => {
    const c = ledgerCandidates([
      { ticket: "COSMOS-1", title: "A", classification: "BUG", resolution: "shipped", ts: "" },
      { ticket: "COSMOS-9", title: "B", classification: "BUG", resolution: "gated", ts: "" },
    ]);
    expect(c.map((x) => x.ref)).toEqual(["COSMOS-1", "COSMOS-9"]);
  });
});
