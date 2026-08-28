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
import { Prisma } from "@prisma/client";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { loadEffectivePermissions, prisma, requireProjectRead } = vi.hoisted(() => ({
  loadEffectivePermissions: vi.fn(),
  requireProjectRead: vi.fn(),
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
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead }));

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

// ── COSMOS-176 ────────────────────────────────────────────────────────────────
// "give me a retro guide" → the model called generate_interval_brief with a
// project id it had INVENTED ("f9s8d7f9-team-proj-id"). The legacy tools cast
// their ids (`input.projectId as string`) into a `where`, so it reached Postgres
// and came back as a thrown PrismaClientKnownRequestError (P2007, "invalid input
// syntax for type uuid"). Nothing between the tool and the SSE stream catches, so
// the driver's message replaced the answer in the chat.
const PROJECT = "22222222-2222-4222-a222-222222222222";
const BAD_ID = "f9s8d7f9-team-proj-id";

/** The exact error Postgres raises for a malformed uuid (verified against the DB). */
function uuidSyntaxError() {
  return new Prisma.PrismaClientKnownRequestError(
    'Invalid `prisma.interval.findFirst()` invocation:\n' +
      `Invalid input value: invalid input syntax for type uuid: "${BAD_ID}"`,
    { code: "P2007", clientVersion: "7.9.1" },
  );
}

describe("executeTool — malformed ids never reach the database", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withBits("CHAT_USE", "SPRINT_READ", "ITEM_READ");
    requireProjectRead.mockResolvedValue(undefined);
  });

  const badIdCases: Array<{ tool: string; input: Record<string, unknown>; spy: () => ReturnType<typeof vi.fn> }> = [
    { tool: "generate_interval_brief", input: { projectId: BAD_ID }, spy: () => prisma.interval.findFirst },
    { tool: "generate_interval_brief", input: { projectId: PROJECT, intervalId: BAD_ID }, spy: () => prisma.interval.findFirst },
    { tool: "query_intervals", input: { projectId: BAD_ID }, spy: () => prisma.interval.findMany },
    { tool: "query_work_items", input: { intervalId: BAD_ID }, spy: () => prisma.workItem.findMany },
  ];

  for (const { tool, input, spy } of badIdCases) {
    it(`${tool} rejects ${Object.keys(input).at(-1)} that is not a UUID, without querying`, async () => {
      const res = (await executeTool(tool, input, CTX)) as { error?: string };

      expect(res.error).toMatch(/UUID/);
      // Actionable, not just "invalid": the model needs to know to look the id up.
      expect(res.error).toMatch(/list_projects|query_intervals/);
      expect(spy()).not.toHaveBeenCalled();
    });
  }

  it("generate_interval_brief still briefs a real project (the valid path is untouched)", async () => {
    prisma.interval.findFirst.mockResolvedValue({
      id: "33333333-3333-4333-a333-333333333333",
      projectId: PROJECT,
      name: "Sprint 4",
      number: 4,
      goal: "ship it",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-08-15"),
    });
    prisma.workItem.findMany.mockResolvedValue([{ storyPoints: 3, completedAt: new Date("2026-08-10") }]);

    const res = (await executeTool("generate_interval_brief", { projectId: PROJECT }, CTX)) as {
      interval?: { name: string };
      progress?: { totalItems: number; percentComplete: number };
    };

    expect(prisma.interval.findFirst).toHaveBeenCalled();
    expect(res.interval).toMatchObject({ name: "Sprint 4" });
    expect(res.progress).toMatchObject({ totalItems: 1, percentComplete: 100 });
  });
});

describe("executeTool — a database error becomes a tool result, not a dead turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withBits("CHAT_USE", "SPRINT_READ");
    requireProjectRead.mockResolvedValue(undefined);
  });

  it("contains a thrown Prisma error and hides the driver's message", async () => {
    prisma.interval.findMany.mockRejectedValue(uuidSyntaxError());

    const res = (await executeTool("query_intervals", { projectId: PROJECT }, CTX)) as { error?: string };

    expect(res.error).toBeTruthy();
    // The driver's text quotes the failing query — it must never reach the chat.
    expect(res.error).not.toMatch(/prisma|invalid input syntax/i);
    expect(res.error).toMatch(/list_projects|query_intervals/);
  });

  it("still rethrows a non-database error (a connector's hard refusal must stay a throw)", async () => {
    prisma.interval.findMany.mockRejectedValue(new Error("commercial-only tool refused for a gov tenant"));

    await expect(executeTool("query_intervals", { projectId: PROJECT }, CTX)).rejects.toThrow(/commercial-only/);
  });
});
