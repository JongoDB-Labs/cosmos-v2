// @vitest-environment node
//
// A read key could rewrite or erase comments its minter published, and create
// or delete saved views, because those writes gated on read bits alone
// (COMMENT_READ, ITEM_READ). For a key they now need the write bit its scope
// would carry (COMMENT_CREATE / ITEM_UPDATE: items:write); a browser session is
// unchanged. Driven through the real handlers.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";

const ORG = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const ME = "88888888-8888-4888-8888-888888888888";

const h = vi.hoisted(() => ({ getAuthContext: vi.fn(), writes: [] as string[] }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
// The real rule, minus project visibility: the action's bit must be held.
vi.mock("@/lib/rbac/require-project-read", () => ({
  requireProjectRead: async (ctx: AuthContext, _p: string, action: keyof typeof Permission) => {
    if (!hasPermission(ctx.permissions, Permission[action])) throw new ForbiddenError("denied");
  },
}));
vi.mock("@/lib/db/client", () => {
  const w = (n: string) => async () => { h.writes.push(n); return { id: "x", authorId: ME, content: "c", createdAt: new Date(), updatedAt: new Date() }; };
  return {
    prisma: {
      organization: { findUnique: async () => ({ id: ORG, slug: "acme", settings: {} }) },
      comment: {
        // The caller's own comment.
        findFirst: async () => ({ id: "c1", authorId: ME, orgId: ORG, workItemId: "w1", subjectType: "RISK" }),
        update: w("comment.update"),
        delete: w("comment.delete"),
      },
      savedView: { findFirst: async () => null, create: w("savedView.create") },
    },
  };
});

import { PATCH as editComment, DELETE as deleteComment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/[commentId]/route";
import { PATCH as editPmComment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/pm-comments/[commentId]/route";
import { POST as createView } from "@/app/api/v1/orgs/[orgId]/saved-views/route";

const READ = Permission.PROJECT_READ | Permission.ITEM_READ | Permission.COMMENT_READ;
const WRITE = READ | Permission.ITEM_UPDATE | Permission.COMMENT_CREATE;
const as = (permissions: bigint, key?: string[]): AuthContext => ({
  userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER, permissions, basePermissions: permissions, abacRules: [],
  ...(key ? { isApiKey: true, scopes: key } : {}),
});
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
const params = { params: Promise.resolve({ orgId: ORG, projectId: P, itemId: "w1", commentId: "c1" }) };

beforeEach(() => { vi.clearAllMocks(); h.writes.length = 0; });

describe("comment edits and deletes", () => {
  it.each([
    ["edit a work-item comment", () => editComment(req("PATCH", { content: "x" }), params as never)],
    ["delete a work-item comment", () => deleteComment(req("DELETE"), params as never)],
    ["edit a PM comment", () => editPmComment(req("PATCH", { content: "x" }), params as never)],
  ])("a read key can't %s it authored", async (_n, call) => {
    h.getAuthContext.mockResolvedValue(as(READ, ["read"]));
    expect((await call()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("an items:write key edits its own comment", async () => {
    h.getAuthContext.mockResolvedValue(as(WRITE, ["items:write"]));
    expect((await editComment(req("PATCH", { content: "x" }), params as never)).status).not.toBe(403);
    expect(h.writes).toContain("comment.update");
  });

  it("a session with only COMMENT_READ still edits its own comment, as before", async () => {
    h.getAuthContext.mockResolvedValue(as(READ));
    expect((await editComment(req("PATCH", { content: "x" }), params as never)).status).not.toBe(403);
    expect(h.writes).toContain("comment.update");
  });
});

describe("saved-view create", () => {
  const create = () => createView(req("POST", { name: "Mine", cql: "status = open" }), { params: Promise.resolve({ orgId: ORG }) });

  it("a read key can't create one", async () => {
    h.getAuthContext.mockResolvedValue(as(READ, ["read"]));
    expect((await create()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("an items:write key and an ITEM_READ session get past the gate", async () => {
    h.getAuthContext.mockResolvedValue(as(WRITE, ["items:write"]));
    expect((await create()).status).not.toBe(403);
    h.getAuthContext.mockResolvedValue(as(READ));
    expect((await create()).status).not.toBe(403);
  });
});
