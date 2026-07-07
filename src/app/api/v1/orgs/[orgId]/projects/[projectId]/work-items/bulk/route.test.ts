// @vitest-environment node
//
// Regression lock for the work-item bulk routes (PUT/DELETE .../work-items/bulk).
// The reported bug: "Couldn't delete the selected items" whenever a user deleted
// MORE than 100 items — the schema capped `ids` at 100, but "select all N
// matching" (v2.128.0) spans the whole result set, so a large selection 400'd.
// These tests assert the cap is now generous AND that large selections are
// chunked into batched deleteMany/updateMany calls (never one giant IN list).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, logAudit, createNotification } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
    workItem: { deleteMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  },
  logAudit: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/notifications/create", () => ({ createNotification }));

import { DELETE, PUT } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";

// All permission bits set → any requirePermission check passes.
const ALL_PERMS = (1n << 64n) - 1n;

function ctx(): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: OrgRole.ADMIN,
    permissions: ALL_PERMS,
    basePermissions: ALL_PERMS,
    abacRules: [],
  };
}

function uuids(n: number): string[] {
  // Deterministic v4-shaped uuids (schema only checks .uuid() format).
  return Array.from({ length: n }, (_, i) => {
    const h = (i + 1).toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${h}`;
  });
}

function delRequest(ids: string[]): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${ORG_ID}/projects/${PROJECT_ID}/work-items/bulk`,
    { method: "DELETE", body: JSON.stringify({ ids }), headers: { "Content-Type": "application/json" } },
  );
}

function putRequest(ids: string[], update: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/orgs/${ORG_ID}/projects/${PROJECT_ID}/work-items/bulk`,
    { method: "PUT", body: JSON.stringify({ ids, update }), headers: { "Content-Type": "application/json" } },
  );
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ctx());
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  prisma.project.findUnique.mockResolvedValue({ key: "ACME" });
  prisma.workItem.findMany.mockResolvedValue([]);
  prisma.workItem.deleteMany.mockImplementation(async ({ where }) => ({
    count: where.id.in.length,
  }));
  prisma.workItem.updateMany.mockImplementation(async ({ where }) => ({
    count: where.id.in.length,
  }));
});

describe("DELETE bulk work-items", () => {
  it("deletes a selection far larger than the old 100 cap (the reported bug)", async () => {
    const res = await DELETE(delRequest(uuids(250)), { params });
    expect(res.status).toBe(204);
    // 250 ids, chunked at 500 → a single batched call covering all of them.
    expect(prisma.workItem.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.workItem.deleteMany.mock.calls[0][0].where.id.in).toHaveLength(250);
  });

  it("chunks a very large selection into batches of 500", async () => {
    const res = await DELETE(delRequest(uuids(1200)), { params });
    expect(res.status).toBe(204);
    // 1200 → 500 + 500 + 200 = 3 chunks.
    expect(prisma.workItem.deleteMany).toHaveBeenCalledTimes(3);
    const sizes = prisma.workItem.deleteMany.mock.calls.map((c) => c[0].where.id.in.length);
    expect(sizes).toEqual([500, 500, 200]);
    // The audit count is the sum across chunks.
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ count: "1200" }) }),
    );
  });

  it("still rejects an empty selection (min 1)", async () => {
    const res = await DELETE(delRequest([]), { params });
    expect(res.status).toBe(400);
    expect(prisma.workItem.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects an absurd selection above the sanity cap", async () => {
    const res = await DELETE(delRequest(uuids(10_001)), { params });
    expect(res.status).toBe(400);
    expect(prisma.workItem.deleteMany).not.toHaveBeenCalled();
  });
});

describe("PUT bulk work-items", () => {
  it("updates a selection larger than 100, chunked", async () => {
    const res = await PUT(putRequest(uuids(600), { priority: "HIGH" }), { params });
    expect(res.status).toBe(200);
    // 600 → 500 + 100 = 2 chunks.
    expect(prisma.workItem.updateMany).toHaveBeenCalledTimes(2);
    const body = (await res.json()) as { updated?: number };
    expect(body.updated).toBe(600);
  });
});
