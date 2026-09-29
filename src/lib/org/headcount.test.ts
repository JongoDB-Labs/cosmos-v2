// @vitest-environment node
//
// The practice KPIs reported "Across 0 active employees" while the Org page
// listed nine people. Both were right about their own table — the org had no HR
// records at all — and the pair still read as a broken product.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    employee: { count: vi.fn() },
    orgMember: { count: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { activeHeadcount } from "./headcount";

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => vi.clearAllMocks());

describe("activeHeadcount", () => {
  it("uses the HR record when the firm keeps one", async () => {
    prisma.employee.count.mockResolvedValue(7);
    expect(await activeHeadcount(ORG)).toBe(7);
    // The deliberate record wins outright; no need to ask who can log in.
    expect(prisma.orgMember.count).not.toHaveBeenCalled();
  });

  it("falls back to org membership when there are no HR records", async () => {
    prisma.employee.count.mockResolvedValue(0);
    prisma.orgMember.count.mockResolvedValue(9);
    expect(await activeHeadcount(ORG)).toBe(9);
  });

  it("leaves guests out of the fallback", async () => {
    // Guests are clients and contractors: people the firm works with, not
    // people it pays, and counting them deflates every per-head figure.
    prisma.employee.count.mockResolvedValue(0);
    prisma.orgMember.count.mockResolvedValue(9);
    await activeHeadcount(ORG);
    expect(prisma.orgMember.count).toHaveBeenCalledWith({
      where: { orgId: ORG, role: { not: "GUEST" } },
    });
  });

  it("returns 0 only when the org genuinely has nobody", async () => {
    prisma.employee.count.mockResolvedValue(0);
    prisma.orgMember.count.mockResolvedValue(0);
    expect(await activeHeadcount(ORG)).toBe(0);
  });
});
