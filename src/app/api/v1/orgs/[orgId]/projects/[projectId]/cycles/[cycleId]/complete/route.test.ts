// @vitest-environment node
//
// Route test for POST /cycles/[cycleId]/complete — the sprint-review /
// finalization handler. Follows the established route-handler harness: mock the
// I/O boundaries (auth/session, db, audit) and call the exported POST directly.
// The retrospective-metrics math (computeSprintMetrics) runs FOR REAL so this
// asserts the persisted report carries burn rate / pacing / efficiency and
// preserves the planning snapshot captured at start.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    cycle: { findFirst: vi.fn(), update: vi.fn() },
    workItem: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

import { POST } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const CYCLE_ID = "33333333-3333-3333-3333-333333333333";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(permissions: bigint) {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

function postReq(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/orgs/o/projects/p/cycles/c/complete",
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, cycleId: CYCLE_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith(bits("SPRINT_COMPLETE")));
  prisma.cycle.findFirst.mockResolvedValue({
    id: CYCLE_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    name: "Sprint 1",
    number: 1,
    status: "ACTIVE",
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: new Date("2026-01-11T00:00:00.000Z"),
    report: { plan: { committedPoints: 8, capacityHours: 40 } },
    workItems: [
      { id: "i1", columnKey: "done", storyPoints: 5, priority: "HIGH" },
      { id: "i2", columnKey: "todo", storyPoints: 3, priority: "LOW" },
    ],
  });
  prisma.$transaction.mockImplementation((cb: (tx: typeof prisma) => unknown) => cb(prisma));
  prisma.workItem.updateMany.mockResolvedValue({ count: 1 });
  prisma.cycle.update.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => ({ id: CYCLE_ID, ...data, _count: { workItems: 2 } }),
  );
  logAudit.mockResolvedValue(undefined);
});

describe("POST /cycles/[cycleId]/complete — retrospective report", () => {
  it("persists a COMPLETED report with velocity, efficiency, burn rate + pacing", async () => {
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(200);

    const arg = prisma.cycle.update.mock.calls[0][0] as { data: { status: string; report: Record<string, unknown> } };
    expect(arg.data.status).toBe("COMPLETED");
    const report = arg.data.report;
    expect(report.velocity).toBe(5);
    expect(report.completedItems).toBe(1);
    expect(report.incompleteItems).toBe(1);
    expect(report.totalStoryPoints).toBe(8);
    expect(report.completedStoryPoints).toBe(5);
    // New retrospective metrics.
    expect(report).toHaveProperty("burnRate");
    expect(report).toHaveProperty("pacing");
    expect(report).toHaveProperty("pointCompletionRate");
    expect(report).toHaveProperty("completedAt");
  });

  it("preserves the planning snapshot (report.plan) captured at sprint start", async () => {
    await POST(postReq(), { params });
    const arg = prisma.cycle.update.mock.calls[0][0] as { data: { report: Record<string, unknown> } };
    expect(arg.data.report.plan).toEqual({ committedPoints: 8, capacityHours: 40 });
  });

  it("returns incomplete items to the backlog when no target cycle is given", async () => {
    await POST(postReq({}), { params });
    expect(prisma.workItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["i2"] } },
      data: { cycleId: null },
    });
  });

  it("rolls incomplete items into a chosen target cycle", async () => {
    const target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await POST(postReq({ moveIncompleteToCycleId: target }), { params });
    expect(prisma.workItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["i2"] } },
      data: { cycleId: target },
    });
  });

  it("rejects completing a non-active cycle with 409", async () => {
    prisma.cycle.findFirst.mockResolvedValueOnce({
      id: CYCLE_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      status: "PLANNED",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-01-11T00:00:00.000Z"),
      report: null,
      workItems: [],
    });
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(409);
    expect(prisma.cycle.update).not.toHaveBeenCalled();
  });

  it("blocks completion without SPRINT_COMPLETE (403)", async () => {
    getAuthContext.mockResolvedValueOnce(ctxWith(bits("SPRINT_READ")));
    const res = await POST(postReq(), { params });
    expect(res.status).toBe(403);
    expect(prisma.cycle.update).not.toHaveBeenCalled();
  });
});
