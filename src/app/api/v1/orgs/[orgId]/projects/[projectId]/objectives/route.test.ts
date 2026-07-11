// @vitest-environment node
//
// COSMOS-82: the objectives GET rolls objective progress up from BOTH key
// results and work items linked directly to the objective, and resolves each
// objective's dependencies. Mocks the I/O boundaries; the real authz runs.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
    objective: { findMany: vi.fn() },
    workItem: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OBJ_A = "33333333-3333-4333-8333-333333333333";
const OBJ_B = "44444444-4444-4444-8444-444444444444";
const ITEM_X = "55555555-5555-4555-8555-555555555555";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}
function ctxWith(permissions: bigint): AuthContext {
  return {
    userId: "99999999-9999-9999-9999-999999999999",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions,
    basePermissions: permissions,
    abacRules: [],
  };
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID });
const getReq = () => new NextRequest("http://localhost/api/v1/orgs/o/projects/p/objectives");

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
  // Objective A: one KR at 50% + one done direct work-item link + depends on B.
  // Objective B: nothing.
  prisma.objective.findMany.mockResolvedValue([
    {
      id: OBJ_A,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      title: "Ship it",
      status: "ACTIVE",
      targetDate: null,
      createdAt: new Date("2026-01-01"),
      keyResults: [
        {
          id: "kr-1",
          startValue: 0,
          currentValue: 50,
          targetValue: 100,
          lowerIsBetter: false,
          sortOrder: 0,
          links: [],
        },
      ],
      links: [
        { kind: "WORK_ITEM", workItemId: ITEM_X, dependsOnObjectiveId: null },
        { kind: "DEPENDS_ON", workItemId: null, dependsOnObjectiveId: OBJ_B },
      ],
    },
    {
      id: OBJ_B,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      title: "Foundation",
      status: "ACTIVE",
      targetDate: null,
      createdAt: new Date("2026-01-01"),
      keyResults: [],
      links: [],
    },
  ]);
  prisma.workItem.findMany.mockResolvedValue([
    { id: ITEM_X, ticketNumber: 7, title: "Do the thing", columnKey: "done", completedAt: new Date() },
  ]);
});

describe("GET /objectives — direct-link roll-up + dependency resolution", () => {
  it("folds a done direct link and a 50% key result into 75% progress", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ")));
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    const a = body.find((o: { id: string }) => o.id === OBJ_A);
    // (KR 50% + direct item 100%) / 2 units = 75
    expect(a.progress).toBe(75);
    expect(a.linkedTotal).toBe(1);
    expect(a.linkedDone).toBe(1);
    expect(a.linkedItems).toHaveLength(1);
  });

  it("resolves dependencies to their objective + progress and drops raw link rows", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ")));
    const res = await GET(getReq(), { params });
    const body = await res.json();
    const a = body.find((o: { id: string }) => o.id === OBJ_A);
    expect(a.dependencies).toEqual([
      { id: OBJ_B, title: "Foundation", status: "ACTIVE", progress: 0 },
    ]);
    // The raw ObjectiveLink rows are not leaked in the payload.
    expect(a.links).toBeUndefined();
  });

  it("requires OKR_READ (403 without it)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("ITEM_READ")));
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(403);
  });
});
