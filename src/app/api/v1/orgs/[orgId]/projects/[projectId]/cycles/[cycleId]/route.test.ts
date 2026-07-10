// @vitest-environment node
//
// Route test for PUT /cycles/[cycleId] — the edit / start (activate) handler.
// Covers the sprint-planning snapshot persisted into `report.plan` when a sprint
// is started, and the merge/drop semantics that must not clobber completion
// metrics also stored in `report`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    cycle: { findFirst: vi.fn(), update: vi.fn() },
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
// Sprint lifecycle fires a best-effort Teams notification — stub the whole module.
vi.mock("@/lib/integrations/teams-notify", () => ({
  teamsNotify: vi.fn(),
  escapeHtmlBasic: (s: string) => s,
}));

import { PUT } from "./route";

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

function putReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/projects/p/cycles/c", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, cycleId: CYCLE_ID });

/** Set the existing cycle row + wire findFirst so the "another active?" lookup
 *  (which filters on status:"ACTIVE") returns none. */
function mockExisting(existing: Record<string, unknown>) {
  prisma.cycle.findFirst.mockImplementation(({ where }: { where: { status?: string } }) =>
    Promise.resolve(where.status === "ACTIVE" ? null : existing),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  getAuthContext.mockResolvedValue(ctxWith(bits("SPRINT_UPDATE")));
  prisma.cycle.update.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => ({
      id: CYCLE_ID,
      name: "Sprint 1",
      ...data,
      _count: { workItems: 0 },
    }),
  );
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /cycles/[cycleId] — sprint-planning snapshot", () => {
  it("stashes the planning snapshot in report.plan when starting a sprint", async () => {
    mockExisting({ id: CYCLE_ID, orgId: ORG_ID, projectId: PROJECT_ID, name: "Sprint 1", status: "PLANNED", report: null });

    const res = await PUT(
      putReq({ status: "ACTIVE", goal: "Ship it", plan: { committedPoints: 5, capacityHours: 20 } }),
      { params },
    );
    expect(res.status).toBe(200);

    const arg = prisma.cycle.update.mock.calls[0][0] as { data: { status?: string; report?: Record<string, unknown> } };
    expect(arg.data.status).toBe("ACTIVE");
    const plan = arg.data.report?.plan as Record<string, unknown>;
    expect(plan.committedPoints).toBe(5);
    expect(plan.capacityHours).toBe(20);
    expect(typeof plan.plannedAt).toBe("string");
  });

  it("merges the plan without clobbering existing report keys", async () => {
    mockExisting({
      id: CYCLE_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      name: "Sprint 1",
      status: "PLANNED",
      report: { velocity: 9, custom: "keep" },
    });

    await PUT(putReq({ plan: { committedPoints: 3, capacityHours: 10 } }), { params });

    const arg = prisma.cycle.update.mock.calls[0][0] as { data: { report?: Record<string, unknown> } };
    expect(arg.data.report?.velocity).toBe(9);
    expect(arg.data.report?.custom).toBe("keep");
    expect((arg.data.report?.plan as Record<string, unknown>).committedPoints).toBe(3);
  });

  it("plan:null drops report.plan but preserves other report keys", async () => {
    mockExisting({
      id: CYCLE_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      name: "Sprint 1",
      status: "PLANNED",
      report: { plan: { committedPoints: 1, capacityHours: 2 }, velocity: 4 },
    });

    await PUT(putReq({ plan: null }), { params });

    const arg = prisma.cycle.update.mock.calls[0][0] as { data: { report?: Record<string, unknown> } };
    expect(arg.data.report).toEqual({ velocity: 4 });
  });

  it("leaves report untouched when no plan field is sent", async () => {
    mockExisting({ id: CYCLE_ID, orgId: ORG_ID, projectId: PROJECT_ID, name: "Sprint 1", status: "PLANNED", report: { velocity: 7 } });

    await PUT(putReq({ goal: "just a goal" }), { params });

    const arg = prisma.cycle.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data).not.toHaveProperty("report");
  });
});
