// @vitest-environment node
//
// Security regression lock: the legacy inline AI tools (query_work_items,
// query_intervals, query_crm, query_finance, generate_interval_brief) must enforce
// the SAME per-tool read permission as the Phase-3b executors. Before the fix
// they queried Prisma scoped only by orgId, so a CHAT_USE user lacking
// FINANCE_READ / CRM_READ could exfiltrate that data via `/ai` or an @ai
// mention. Mock ONLY the I/O boundaries; leave assertPermission/hasPermission
// (the bitfield check) running against a crafted permission mask.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { loadEffectivePermissions, prisma } = vi.hoisted(() => ({
  loadEffectivePermissions: vi.fn(),
  prisma: {
    crmContact: { findMany: vi.fn() },
    revenue: { findMany: vi.fn() },
    expense: { findMany: vi.fn() },
    workItem: { findMany: vi.fn() },
    interval: { findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/rbac/effective-permissions", () => ({ loadEffectivePermissions }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { executeTool } from "./tool-executor";

const CTX = { orgId: "11111111-1111-1111-1111-111111111111", userId: "u1" };

function withBits(...keys: PermissionKey[]) {
  const permissions = keys.reduce((acc, k) => acc | Permission[k], 0n);
  loadEffectivePermissions.mockResolvedValue({ orgRole: "MEMBER", permissions });
}

describe("executeTool — legacy read tools enforce per-tool permissions", () => {
  beforeEach(() => vi.clearAllMocks());

  const denyCases: Array<{ tool: string; need: PermissionKey; spy: () => ReturnType<typeof vi.fn> }> = [
    { tool: "query_crm", need: "CRM_READ", spy: () => prisma.crmContact.findMany },
    { tool: "query_finance", need: "FINANCE_READ", spy: () => prisma.revenue.findMany },
    { tool: "query_work_items", need: "ITEM_READ", spy: () => prisma.workItem.findMany },
    { tool: "query_intervals", need: "SPRINT_READ", spy: () => prisma.interval.findMany },
    { tool: "generate_interval_brief", need: "SPRINT_READ", spy: () => prisma.interval.findFirst },
  ];

  for (const { tool, need, spy } of denyCases) {
    it(`${tool} is denied (and never touches the DB) without ${need}`, async () => {
      withBits("CHAT_USE"); // has CHAT_USE but NOT the read bit
      const res = await executeTool(tool, { projectId: "p1" }, CTX);
      expect(res).toEqual({ error: "Insufficient permissions" });
      expect(spy()).not.toHaveBeenCalled();
    });
  }

  it("query_crm proceeds to the query once CRM_READ is granted", async () => {
    withBits("CHAT_USE", "CRM_READ");
    prisma.crmContact.findMany.mockResolvedValue([]);
    const res = await executeTool("query_crm", {}, CTX);
    expect(prisma.crmContact.findMany).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ count: 0 });
  });

  it("query_finance proceeds once FINANCE_READ is granted", async () => {
    withBits("CHAT_USE", "FINANCE_READ");
    prisma.revenue.findMany.mockResolvedValue([]);
    prisma.expense.findMany.mockResolvedValue([]);
    const res = await executeTool("query_finance", {}, CTX);
    expect(prisma.revenue.findMany).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ totalRevenue: 0, totalExpenses: 0, netIncome: 0 });
  });
});
