import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Two overlapping remediation runs must not both process the same items.
 *
 * `deliveredAt` is stamped only on SUCCESS, so it says nothing about an item a
 * run is working on right now. Two runs therefore both see `deliveredAt: null`,
 * both classify it, and both create a work item — exactly what happened on prod:
 * a client fetch timed out at 45s while the run continued server-side, a second
 * run was fired, and the pair produced 9 duplicate work items.
 */
vi.mock("@/lib/db/client", () => ({
  prisma: { organization: { findUnique: vi.fn(async () => null) } },
}));

import { runFeedbackRemediation } from "@/lib/feedback/remediate";

describe("remediation run guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a second run for the same org while one is in flight", async () => {
    const [a, b] = await Promise.all([
      runFeedbackRemediation("org-1", { actorUserId: "u" }),
      runFeedbackRemediation("org-1", { actorUserId: "u" }),
    ]);
    expect([a.skipped, b.skipped]).toContain("already-running");
  });

  it("releases the guard, so a later run is not refused", async () => {
    await runFeedbackRemediation("org-2", { actorUserId: "u" });
    const again = await runFeedbackRemediation("org-2", { actorUserId: "u" });
    expect(again.skipped).not.toBe("already-running");
  });

  it("does not block a DIFFERENT org — the guard is per-org, not global", async () => {
    const [a, b] = await Promise.all([
      runFeedbackRemediation("org-3", { actorUserId: "u" }),
      runFeedbackRemediation("org-4", { actorUserId: "u" }),
    ]);
    expect([a.skipped, b.skipped]).not.toContain("already-running");
  });
});
