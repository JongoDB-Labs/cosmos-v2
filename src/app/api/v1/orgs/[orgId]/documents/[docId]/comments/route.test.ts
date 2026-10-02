import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";

const { prisma, resolveAuth, readableDocument, canManageDocument } = vi.hoisted(() => ({
  prisma: {
    organization: { findUnique: vi.fn() },
    comment: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    user: { findMany: vi.fn() },
  },
  resolveAuth: vi.fn(),
  readableDocument: vi.fn(),
  canManageDocument: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/api-key", () => ({ resolveAuth }));
vi.mock("@/lib/files/access", () => ({ readableDocument, canManageDocument }));

import { GET, POST } from "./route";
import { DELETE } from "./[commentId]/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const SOMEONE = "33333333-3333-4333-8333-333333333333";
const DOC = "55555555-5555-4555-8555-555555555555";
const COMMENT = "77777777-7777-4777-8777-777777777777";

const bits = (...k: PermissionKey[]) => k.reduce((a, x) => a | Permission[x], 0n);
function ctx(...k: PermissionKey[]): AuthContext {
  const permissions = bits(...k);
  return {
    userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER,
    permissions, basePermissions: permissions, abacRules: [],
  } as AuthContext;
}
const url = `http://localhost/api/v1/orgs/o/documents/${DOC}/comments`;
const params = Promise.resolve({ orgId: ORG, docId: DOC });
const delParams = Promise.resolve({ orgId: ORG, docId: DOC, commentId: COMMENT });
const post = (content: unknown) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG, slug: "o" });
  resolveAuth.mockResolvedValue(ctx("ORG_READ"));
  readableDocument.mockResolvedValue({ id: DOC, orgId: ORG, projectId: null, uploadedById: SOMEONE });
  canManageDocument.mockResolvedValue(false);
  prisma.comment.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
});

describe("GET comments", () => {
  it("asks only for comments on THIS document", async () => {
    await GET(new NextRequest(url), { params });
    expect(prisma.comment.findMany.mock.calls[0][0].where).toEqual({
      orgId: ORG, subjectType: "document", subjectId: DOC,
    });
  });

  it("is 404 when the file is not readable, so a thread cannot leak the file", async () => {
    readableDocument.mockResolvedValue(null);
    expect((await GET(new NextRequest(url), { params })).status).toBe(404);
    expect(prisma.comment.findMany).not.toHaveBeenCalled();
  });

  it("names the author and says which are mine, without returning raw ids", async () => {
    prisma.comment.findMany.mockResolvedValue([
      { id: "c1", content: "hi", authorId: ME, createdAt: new Date(), updatedAt: new Date() },
      { id: "c2", content: "yo", authorId: SOMEONE, createdAt: new Date(), updatedAt: new Date() },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: ME, displayName: "Me", avatarUrl: null }]);
    const body = await (await GET(new NextRequest(url), { params })).json();
    expect(body[0].author.displayName).toBe("Me");
    expect(body[0].mine).toBe(true);
    // The other author has left: the row stays, labelled.
    expect(body[1].author.displayName).toBe("Former member");
    expect(body[1].mine).toBe(false);
    expect(body[0]).not.toHaveProperty("authorId");
  });
});

describe("POST a comment", () => {
  it("is allowed to somebody who may READ the file but not change it", async () => {
    // The point of the rule: commenting is how a person who may look at a
    // drawing but not alter it says what is wrong with it.
    canManageDocument.mockResolvedValue(false);
    prisma.comment.create.mockResolvedValue({
      id: "c1", content: "looks wrong", authorId: ME, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await POST(post("looks wrong"), { params });
    expect(res.status).toBe(201);
    expect(prisma.comment.create.mock.calls[0][0].data).toEqual({
      orgId: ORG, subjectType: "document", subjectId: DOC, authorId: ME, content: "looks wrong",
    });
  });

  it("refuses an empty or whitespace-only comment", async () => {
    expect((await POST(post("   "), { params })).status).toBe(400);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it("is 404 when the file is not readable", async () => {
    readableDocument.mockResolvedValue(null);
    expect((await POST(post("hi"), { params })).status).toBe(404);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });
});

describe("DELETE a comment", () => {
  const req = () => new NextRequest(url, { method: "DELETE" });

  it("lets the author remove their own", async () => {
    prisma.comment.findFirst.mockResolvedValue({ id: COMMENT, authorId: ME });
    prisma.comment.delete.mockResolvedValue({ id: COMMENT });
    expect((await DELETE(req(), { params: delParams })).status).toBe(200);
  });

  it("refuses somebody else's comment when they do not manage the file", async () => {
    prisma.comment.findFirst.mockResolvedValue({ id: COMMENT, authorId: SOMEONE });
    canManageDocument.mockResolvedValue(false);
    expect((await DELETE(req(), { params: delParams })).status).toBe(403);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });

  it("lets whoever manages the file moderate any comment on it", async () => {
    prisma.comment.findFirst.mockResolvedValue({ id: COMMENT, authorId: SOMEONE });
    canManageDocument.mockResolvedValue(true);
    expect((await DELETE(req(), { params: delParams })).status).toBe(200);
  });

  it("will not delete a comment that belongs to a different subject", async () => {
    prisma.comment.findFirst.mockResolvedValue(null);
    expect((await DELETE(req(), { params: delParams })).status).toBe(404);
    // Scoped on subject as well as id, so a work-item comment id cannot be
    // deleted through the documents door.
    expect(prisma.comment.findFirst.mock.calls[0][0].where).toEqual({
      id: COMMENT, orgId: ORG, subjectType: "document", subjectId: DOC,
    });
  });
});
