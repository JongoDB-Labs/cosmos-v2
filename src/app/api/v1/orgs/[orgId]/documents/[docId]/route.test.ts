import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const {
  prisma, resolveAuth, readableDocument, canManageDocument, logAudit, getStorage,
} = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    document: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    workItem: { findFirst: vi.fn() },
    comment: { deleteMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  resolveAuth: vi.fn(),
  readableDocument: vi.fn(),
  canManageDocument: vi.fn(),
  logAudit: vi.fn(),
  getStorage: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/api-key", () => ({ resolveAuth }));
vi.mock("@/lib/files/access", () => ({ readableDocument, canManageDocument }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/storage", () => ({ getStorage }));

import { PATCH, DELETE } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const DOC = "55555555-5555-4555-8555-555555555555";
const ITEM = "66666666-6666-4666-8666-666666666666";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
function ctx(...k: PermissionKey[]): AuthContext {
  const permissions = bits(...k);
  return {
    userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER,
    permissions, basePermissions: permissions, abacRules: [],
  } as AuthContext;
}
const params = Promise.resolve({ orgId: ORG, docId: DOC });
const patch = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/orgs/o/documents/${DOC}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = () =>
  new NextRequest(`http://localhost/api/v1/orgs/o/documents/${DOC}`, { method: "DELETE" });

const policyDoc = { id: DOC, orgId: ORG, projectId: PROJECT, uploadedById: ME };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "o" });
  resolveAuth.mockResolvedValue(ctx("ORG_READ"));
  readableDocument.mockResolvedValue(policyDoc);
  canManageDocument.mockResolvedValue(true);
  prisma.document.update.mockResolvedValue({
    id: DOC, title: "New name", filename: "plan.dwg", projectId: PROJECT,
    workItemId: null, uploadedById: ME, createdAt: new Date(), updatedAt: new Date(),
  });
  prisma.document.findFirst.mockResolvedValue({
    storageKey: "k", filename: "plan.dwg", size: 1, contentType: "x",
    uploadedById: ME, workItemId: null, createdAt: new Date(),
  });
  prisma.document.delete.mockResolvedValue({ id: DOC });
  prisma.comment.deleteMany.mockResolvedValue({ count: 0 });
  prisma.user.findMany.mockResolvedValue([{ id: ME, displayName: "Me", avatarUrl: null }]);
  getStorage.mockReturnValue({ delete: vi.fn().mockResolvedValue(undefined) });
});

describe("PATCH — rename", () => {
  it("renames the title", async () => {
    const res = await PATCH(patch({ title: "New name" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.document.update.mock.calls[0][0].data).toEqual({ title: "New name" });
  });

  it("CANNOT change the filename, because the filename decides how it is served", async () => {
    // The serving policy reads the extension to pick inline / text / sandbox /
    // attachment. A rename that could set filename would let somebody move an
    // uploaded file between those tiers after the fact.
    const res = await PATCH(patch({ title: "x", filename: "evil.html" }), { params });
    expect(res.status).toBe(200);
    expect(prisma.document.update.mock.calls[0][0].data).not.toHaveProperty("filename");
  });

  it("rejects an empty change", async () => {
    expect((await PATCH(patch({}), { params })).status).toBe(400);
  });

  it("answers 404, not 403, for a file the actor cannot see", async () => {
    readableDocument.mockResolvedValue(null);
    const res = await PATCH(patch({ title: "x" }), { params });
    // 403 would confirm the id exists to somebody with no right to know.
    expect(res.status).toBe(404);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it("answers 403 for a file the actor can see but did not upload", async () => {
    canManageDocument.mockResolvedValue(false);
    expect((await PATCH(patch({ title: "x" }), { params })).status).toBe(403);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

describe("PATCH — attach and detach from the Files side", () => {
  it("detaches on an explicit null", async () => {
    await PATCH(patch({ workItemId: null }), { params });
    expect(prisma.document.update.mock.calls[0][0].data).toEqual({ workItemId: null });
    expect(prisma.workItem.findFirst).not.toHaveBeenCalled();
  });

  it("will not attach to an item on a DIFFERENT project", async () => {
    // The lookup is scoped to this document's project, so an item elsewhere is
    // not found. Without that, a file could be hung off a ticket on a job its
    // reader cannot see, and that ticket's attachment list would disclose it.
    prisma.workItem.findFirst.mockResolvedValue(null);
    const res = await PATCH(patch({ workItemId: ITEM }), { params });
    expect(res.status).toBe(400);
    expect(prisma.workItem.findFirst.mock.calls[0][0].where).toEqual({
      id: ITEM, orgId: ORG, projectId: PROJECT,
    });
    expect(prisma.document.update).not.toHaveBeenCalled();
    expect(OTHER_PROJECT).not.toBe(PROJECT); // the case this guards
  });

  it("attaches to an item on the same project", async () => {
    prisma.workItem.findFirst.mockResolvedValue({ id: ITEM, projectId: PROJECT });
    const res = await PATCH(patch({ workItemId: ITEM }), { params });
    expect(res.status).toBe(200);
    expect(prisma.document.update.mock.calls[0][0].data).toEqual({ workItemId: ITEM });
  });
});

describe("DELETE", () => {
  it("removes the bytes, the row and the comments on it", async () => {
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    getStorage.mockReturnValue(storage);
    const res = await DELETE(del(), { params });
    expect(res.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledWith("k");
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: DOC } });
    // Comments are polymorphic, so no foreign key cascades them.
    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({
      where: { orgId: ORG, subjectType: "document", subjectId: DOC },
    });
  });

  it("records what was deleted, and that the owner did it", async () => {
    await DELETE(del(), { params });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.delete",
        metadata: expect.objectContaining({ filename: "plan.dwg", asOwner: true }),
      }),
    );
  });

  it("is 404 for a file the actor cannot see, and deletes nothing", async () => {
    readableDocument.mockResolvedValue(null);
    expect((await DELETE(del(), { params })).status).toBe(404);
    expect(prisma.document.delete).not.toHaveBeenCalled();
  });

  it("is 403 for a file the actor can see but may not manage", async () => {
    canManageDocument.mockResolvedValue(false);
    expect((await DELETE(del(), { params })).status).toBe(403);
    expect(prisma.document.delete).not.toHaveBeenCalled();
  });
});
