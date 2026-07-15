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
  it("never dedups a decomposition child against its parent epic", async () => {
    // COSMOS-119 (parent_id=114) vs its own near-identical parent epic COSMOS-114.
    const judge = vi.fn();
    const r = await dedupGate(
      {
        title: "Phase 3: build the reporting export pipeline",
        parentRef: "COSMOS-114",
        candidates: [{ ref: "COSMOS-114", title: "Build the reporting export pipeline" }],
      },
      judge,
      0.5,
    );
    expect(r.dupOf).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });
  it("never dedups a decomposition child against a sibling child of the same epic", async () => {
    // COSMOS-119 vs sibling COSMOS-120 — both parent_id=114.
    const judge = vi.fn();
    const r = await dedupGate(
      {
        title: "Phase 3: reporting export pipeline",
        parentRef: "COSMOS-114",
        candidates: [{ ref: "COSMOS-120", title: "Phase 3 reporting export pipeline", parentRef: "COSMOS-114" }],
      },
      judge,
      0.5,
    );
    expect(r.dupOf).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });
  it("still catches a legitimate cross-ticket duplicate outside the epic family", async () => {
    const judge = vi.fn().mockResolvedValue({ dupOf: "COSMOS-2", reason: "same work-role bug" });
    const r = await dedupGate(
      {
        title: "Failing to create work role",
        parentRef: "COSMOS-114",
        candidates: [
          { ref: "COSMOS-114", title: "Failing to create work role" }, // parent — excluded
          { ref: "COSMOS-2", title: "Cannot create work role" }, // unrelated prior — real dup
        ],
      },
      judge,
      0.5,
    );
    expect(judge).toHaveBeenCalledOnce();
    // The judge only ever sees the eligible (non-family) shortlist.
    expect(judge.mock.calls[0][1].map((c: { ref: string }) => c.ref)).toEqual(["COSMOS-2"]);
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
