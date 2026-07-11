// @vitest-environment node
//
// COSMOS-82: linking work items (deliverables) and other objectives
// (dependencies) to an objective. Follows the repo's route-handler harness —
// mock the I/O boundaries (auth, prisma) and let the REAL authz engine run.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    objective: { findFirst: vi.fn() },
    workItem: { findFirst: vi.fn(), findMany: vi.fn() },
    objectiveLink: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { POST, DELETE } from "./route";

// Valid v4 UUIDs (version nibble 4, variant nibble 8) — the route validates
// `targetId` with zod's strict `z.string().uuid()`.
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OBJECTIVE_ID = "33333333-3333-4333-8333-333333333333";
const WORK_ITEM_ID = "44444444-4444-4444-8444-444444444444";
const DEP_OBJECTIVE_ID = "55555555-5555-4555-8555-555555555555";

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

function req(body: Record<string, unknown>, method = "POST"): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/orgs/o/projects/p/objectives/x/links",
    { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, objectiveId: OBJECTIVE_ID });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.objective.findFirst.mockResolvedValue({ id: OBJECTIVE_ID });
  prisma.workItem.findFirst.mockResolvedValue({ id: WORK_ITEM_ID });
  prisma.objectiveLink.findFirst.mockResolvedValue(null);
  prisma.objectiveLink.create.mockResolvedValue({ id: "link-1" });
  prisma.objectiveLink.deleteMany.mockResolvedValue({ count: 1 });
});

describe("POST /objectives/[objectiveId]/links — OKR_UPDATE authz", () => {
  it("without OKR_UPDATE → 403 and no write", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ")));
    const res = await POST(req({ kind: "WORK_ITEM", targetId: WORK_ITEM_ID }), { params });
    expect(res.status).toBe(403);
    expect(prisma.objectiveLink.create).not.toHaveBeenCalled();
  });

  it("links a work item as a deliverable (201)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ", "OKR_UPDATE")));
    const res = await POST(req({ kind: "WORK_ITEM", targetId: WORK_ITEM_ID }), { params });
    expect(res.status).toBe(201);
    expect(prisma.objectiveLink.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { objectiveId: OBJECTIVE_ID, kind: "WORK_ITEM", workItemId: WORK_ITEM_ID },
      }),
    );
  });

  it("rejects a work item that isn't in this project (400)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ", "OKR_UPDATE")));
    prisma.workItem.findFirst.mockResolvedValue(null);
    const res = await POST(req({ kind: "WORK_ITEM", targetId: WORK_ITEM_ID }), { params });
    expect(res.status).toBe(400);
    expect(prisma.objectiveLink.create).not.toHaveBeenCalled();
  });

  it("links a dependency on another objective (201)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ", "OKR_UPDATE")));
    prisma.objective.findFirst
      .mockResolvedValueOnce({ id: OBJECTIVE_ID }) // loadObjective
      .mockResolvedValueOnce({ id: DEP_OBJECTIVE_ID }); // dependency target
    const res = await POST(req({ kind: "DEPENDS_ON", targetId: DEP_OBJECTIVE_ID }), { params });
    expect(res.status).toBe(201);
    expect(prisma.objectiveLink.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { objectiveId: OBJECTIVE_ID, kind: "DEPENDS_ON", dependsOnObjectiveId: DEP_OBJECTIVE_ID },
      }),
    );
  });

  it("refuses a self-dependency (400)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ", "OKR_UPDATE")));
    const res = await POST(req({ kind: "DEPENDS_ON", targetId: OBJECTIVE_ID }), { params });
    expect(res.status).toBe(400);
    expect(prisma.objectiveLink.create).not.toHaveBeenCalled();
  });

  it("is idempotent — an existing link is returned, not duplicated (201)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ", "OKR_UPDATE")));
    prisma.objectiveLink.findFirst.mockResolvedValue({ id: "existing" });
    const res = await POST(req({ kind: "WORK_ITEM", targetId: WORK_ITEM_ID }), { params });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ linkId: "existing" });
    expect(prisma.objectiveLink.create).not.toHaveBeenCalled();
  });
});

describe("DELETE /objectives/[objectiveId]/links", () => {
  it("without OKR_UPDATE → 403 and no delete", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ")));
    const res = await DELETE(req({ kind: "WORK_ITEM", targetId: WORK_ITEM_ID }, "DELETE"), { params });
    expect(res.status).toBe(403);
    expect(prisma.objectiveLink.deleteMany).not.toHaveBeenCalled();
  });

  it("unlinks a deliverable (200)", async () => {
    getAuthContext.mockResolvedValue(ctxWith(bits("OKR_READ", "OKR_UPDATE")));
    const res = await DELETE(req({ kind: "WORK_ITEM", targetId: WORK_ITEM_ID }, "DELETE"), { params });
    expect(res.status).toBe(200);
    expect(prisma.objectiveLink.deleteMany).toHaveBeenCalledWith({
      where: { objectiveId: OBJECTIVE_ID, kind: "WORK_ITEM", workItemId: WORK_ITEM_ID },
    });
  });
});
