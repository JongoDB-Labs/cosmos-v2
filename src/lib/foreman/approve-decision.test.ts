import { describe, it, expect } from "vitest";
import { decideApprove } from "./approve-decision";

describe("decideApprove", () => {
  it("merges when a PR exists and is not yet merged", () => {
    expect(decideApprove({ hasPr: true, prMerged: false })).toBe("merge");
  });

  it("is reconcile-only when the PR is already merged", () => {
    expect(decideApprove({ hasPr: true, prMerged: true })).toBe("reconcile-only");
  });

  it("is nothing-built when there is no PR", () => {
    expect(decideApprove({ hasPr: false, prMerged: false })).toBe("nothing-built");
  });

  it("prefers nothing-built over prMerged when hasPr is false (no PR can't be merged)", () => {
    // Defensive: prMerged is meaningless without a PR — the absence of a PR wins.
    expect(decideApprove({ hasPr: false, prMerged: true })).toBe("nothing-built");
  });
});
