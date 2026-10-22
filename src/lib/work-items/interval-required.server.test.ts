// COSMOS-205, server side: the create API and the assistant's create tool both
// ask intervalRequirementError before writing, so no path skips the rule.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    workItemType: { findUnique: vi.fn() },
    interval: { count: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { intervalRequirementError } from "./interval-required.server";
import { INTERVAL_REQUIRED_MESSAGE } from "./interval-required";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.interval.count.mockResolvedValue(3);
});

const args = { projectId: "p1", workItemTypeId: "t1" };

describe("intervalRequirementError", () => {
  it("rejects a Story with no interval in a project that has intervals", async () => {
    prisma.workItemType.findUnique.mockResolvedValue({ key: "software.story" });
    expect(await intervalRequirementError({ ...args, intervalId: null })).toBe(INTERVAL_REQUIRED_MESSAGE);
  });

  it("accepts the same Story once it has an interval", async () => {
    prisma.workItemType.findUnique.mockResolvedValue({ key: "software.story" });
    expect(await intervalRequirementError({ ...args, intervalId: "i1" })).toBeNull();
  });

  it("accepts a Story in a project with no intervals", async () => {
    prisma.workItemType.findUnique.mockResolvedValue({ key: "software.story" });
    prisma.interval.count.mockResolvedValue(0);
    expect(await intervalRequirementError({ ...args, intervalId: undefined })).toBeNull();
  });

  it("accepts other types without an interval", async () => {
    prisma.workItemType.findUnique.mockResolvedValue({ key: "software.task" });
    expect(await intervalRequirementError({ ...args, intervalId: null })).toBeNull();
  });
});
