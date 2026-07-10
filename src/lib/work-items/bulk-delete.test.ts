import { describe, it, expect } from "vitest";
import { summarizeBulkDelete, type BulkDeleteGroupResult } from "./bulk-delete";

const ok = (projectId: string, ids: string[], projectLabel?: string): BulkDeleteGroupResult => ({
  projectId,
  projectLabel,
  ids,
  ok: true,
});
const fail = (
  projectId: string,
  ids: string[],
  reason?: string,
  projectLabel?: string,
): BulkDeleteGroupResult => ({ projectId, projectLabel, ids, ok: false, reason });

describe("summarizeBulkDelete", () => {
  it("reports no error and the full count when every project succeeds", () => {
    const s = summarizeBulkDelete([ok("p1", ["a", "b"]), ok("p2", ["c"])]);
    expect(s.deleted).toBe(3);
    expect(s.failedIds).toEqual([]);
    expect(s.errorMessage).toBeNull();
  });

  it("preserves the succeeded deletes and names which project failed and why (the reported bug)", () => {
    // Pre-fix, a fan-out used Promise.all: the first rejection aborted the whole
    // flow, so p1 stayed deleted, the selection was never cleared, and the user
    // only ever saw a generic "Couldn't delete the selected items."
    const s = summarizeBulkDelete([
      ok("p1", ["a", "b"], "ACME"),
      fail("p2", ["c", "d"], "Forbidden", "BETA"),
    ]);
    expect(s.deleted).toBe(2);
    // Failed ids stay selected so the user can retry just those.
    expect(s.failedIds).toEqual(["c", "d"]);
    expect(s.errorMessage).toBe(
      "Deleted 2 issues of 4. Couldn't delete 2: BETA: Forbidden.",
    );
  });

  it("uses the 'couldn't delete' lead when nothing succeeded", () => {
    const s = summarizeBulkDelete([fail("p1", ["a"], "Server error", "ACME")]);
    expect(s.deleted).toBe(0);
    expect(s.failedIds).toEqual(["a"]);
    expect(s.errorMessage).toBe("Couldn't delete 1 issue: ACME: Server error.");
  });

  it("aggregates multiple failing projects into one message", () => {
    const s = summarizeBulkDelete([
      fail("p1", ["a"], "Forbidden", "ACME"),
      fail("p2", ["b", "c"], "Not found", "BETA"),
    ]);
    expect(s.failedIds).toEqual(["a", "b", "c"]);
    expect(s.errorMessage).toBe(
      "Couldn't delete 3 issues: ACME: Forbidden; BETA: Not found.",
    );
  });

  it("falls back to a friendly reason and omits an unknown project label", () => {
    const s = summarizeBulkDelete([fail("p1", ["a"])]);
    expect(s.errorMessage).toBe("Couldn't delete 1 issue: an unexpected error.");
  });
});
