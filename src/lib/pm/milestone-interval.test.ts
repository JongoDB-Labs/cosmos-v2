import { describe, it, expect, vi, beforeEach } from "vitest";
import { IntervalKind } from "@prisma/client";
import { NotFoundError, ConflictError } from "@/lib/rbac/check";

const findFirst = vi.fn();
vi.mock("@/lib/db/client", () => ({
  prisma: { interval: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

const { assertMilestoneInterval } = await import("./milestone-interval");

const ORG = "org-1";
const PROJECT = "proj-1";

beforeEach(() => findFirst.mockReset());

describe("assertMilestoneInterval", () => {
  it("accepts a Program Increment in the milestone's own project", async () => {
    findFirst.mockResolvedValue({
      projectId: PROJECT,
      intervalKind: IntervalKind.PROGRAM_INCREMENT,
    });
    await expect(
      assertMilestoneInterval("pi-1", ORG, PROJECT),
    ).resolves.toBeUndefined();
  });

  it("clears the link without a lookup when the id is null", async () => {
    await expect(assertMilestoneInterval(null, ORG, PROJECT)).resolves.toBeUndefined();
    // A null must not cost a query — and must never 404.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects an interval belonging to a different project", async () => {
    // The FK cannot express this: Postgres accepts any interval id.
    findFirst.mockResolvedValue({
      projectId: "some-other-project",
      intervalKind: IntervalKind.PROGRAM_INCREMENT,
    });
    await expect(assertMilestoneInterval("pi-1", ORG, PROJECT)).rejects.toThrow(
      ConflictError,
    );
  });

  it("rejects a sprint — only a Program Increment may hold a milestone", async () => {
    findFirst.mockResolvedValue({
      projectId: PROJECT,
      intervalKind: IntervalKind.SPRINT,
    });
    await expect(assertMilestoneInterval("sprint-1", ORG, PROJECT)).rejects.toThrow(
      ConflictError,
    );
  });

  it("404s when the interval does not exist in this org", async () => {
    findFirst.mockResolvedValue(null);
    await expect(assertMilestoneInterval("ghost", ORG, PROJECT)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("scopes the lookup to the org so another tenant's PI cannot be referenced", async () => {
    findFirst.mockResolvedValue({
      projectId: PROJECT,
      intervalKind: IntervalKind.PROGRAM_INCREMENT,
    });
    await assertMilestoneInterval("pi-1", ORG, PROJECT);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pi-1", orgId: ORG } }),
    );
  });
});
