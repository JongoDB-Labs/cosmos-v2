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

const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  writes: [] as string[],
  view: null as unknown,
  /** What viewerScope reports: the real one caps an admin's KEY to false. */
  isAdmin: false,
  canSee: true,
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
// The real rule, minus project visibility: the action's bit must be held.
vi.mock("@/lib/rbac/require-project-read", () => ({
  requireProjectRead: async (ctx: AuthContext, _p: string, action: keyof typeof Permission) => {
    if (!hasPermission(ctx.permissions, Permission[action])) throw new ForbiddenError("denied");
  },
}));
vi.mock("@/lib/db/client", async () => {
  const { commentRow } = await import("@/lib/openapi/testing/rows");
  const w = (n: string) => async () => { h.writes.push(n); return { id: "x", authorId: ME, content: "c", createdAt: new Date(), updatedAt: new Date() }; };
  return {
    prisma: {
      organization: { findUnique: async () => ({ id: ORG, slug: "acme", settings: {} }) },
      comment: {
        // The caller's own comment.
        findFirst: async () => ({ id: "c1", authorId: ME, orgId: ORG, workItemId: "w1", subjectType: "RISK" }),
        // A whole row: the work-item route answers it through its contract.
        update: async () => { h.writes.push("comment.update"); return commentRow({ id: "44444444-4444-4444-8444-444444444444", orgId: ORG, authorId: ME }); },
        delete: w("comment.delete"),
      },
      // `h.view` is the caller's own view where a test needs one; none (so no
      // name clash) for create.
      savedView: {
        findFirst: async () => h.view, create: w("savedView.create"), delete: w("savedView.delete"), update: w("savedView.update"),
      },
      savedViewFavorite: {
        aggregate: async () => ({ _max: { sortOrder: null } }),
        upsert: async () => { h.writes.push("favorite.upsert"); return { sortOrder: 0 }; },
        deleteMany: w("favorite.delete"),
      },
    },
  };
});

// Visibility is not what's under test: the caller can see and owns the view.
vi.mock("@/lib/query/saved-filters.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/query/saved-filters.server")>()),
  viewerScope: async (ctx: AuthContext) => ({ ctx, isAdmin: h.isAdmin }),
  canSee: () => h.canSee,
  canDelete: () => true,
  canEdit: () => true,
}));

import { PATCH as editComment, DELETE as deleteComment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/[commentId]/route";
import { PATCH as editPmComment, DELETE as deletePmComment } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/pm-comments/[commentId]/route";
import { DELETE as deleteView, PATCH as editView, PUT as legacyEditView } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/route";
import { PUT as starView, DELETE as unstarView } from "@/app/api/v1/orgs/[orgId]/saved-views/[viewId]/favorite/route";
import { POST as createView } from "@/app/api/v1/orgs/[orgId]/saved-views/route";

const READ = Permission.PROJECT_READ | Permission.ITEM_READ | Permission.COMMENT_READ;
const WRITE = READ | Permission.ITEM_UPDATE | Permission.COMMENT_CREATE;
const as = (permissions: bigint, key?: string[]): AuthContext => ({
  userId: ME, orgId: ORG, orgRole: OrgRole.MEMBER, permissions, basePermissions: permissions, abacRules: [],
  ...(key ? { isApiKey: true, scopes: key } : {}),
});
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
// UUIDs: the work-item comment route's contract validates its path.
const params = { params: Promise.resolve({ orgId: ORG, projectId: P, itemId: "33333333-3333-4333-8333-333333333333", commentId: "44444444-4444-4444-8444-444444444444" }) };

beforeEach(() => { vi.clearAllMocks(); h.writes.length = 0; h.view = null; h.isAdmin = false; h.canSee = true; });

describe("comment edits and deletes", () => {
  it.each([
    ["edit a work-item comment", () => editComment(req("PATCH", { content: "x" }), params as never)],
    ["delete a work-item comment", () => deleteComment(req("DELETE"), params as never)],
    ["edit a PM comment", () => editPmComment(req("PATCH", { content: "x" }), params as never)],
    ["delete a PM comment", () => deletePmComment(req("DELETE"), params as never)],
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

describe("saved-view delete, star and unstar", () => {
  const viewParams = { params: Promise.resolve({ orgId: ORG, viewId: "v1" }) };
  const OWN_VIEW = { id: "v1", orgId: ORG, ownerId: ME, name: "Mine", visibility: "PRIVATE", projectId: null, teamId: null, editors: [] };
  const calls = [
    ["delete", () => deleteView(req("DELETE"), viewParams as never), "savedView.delete"],
    ["star", () => starView(req("PUT", {}), viewParams as never), "favorite.upsert"],
    ["unstar", () => unstarView(req("DELETE"), viewParams as never), "favorite.delete"],
  ] as const;

  it.each(calls)("a read key can't %s its own view", async (_n, call) => {
    h.view = OWN_VIEW;
    h.getAuthContext.mockResolvedValue(as(READ, ["read"]));
    expect((await call()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it.each(calls)("an items:write key and an ITEM_READ session can %s it", async (_n, call, write) => {
    h.view = OWN_VIEW;
    h.getAuthContext.mockResolvedValue(as(WRITE, ["items:write"]));
    expect((await call()).status).toBeLessThan(300);
    h.getAuthContext.mockResolvedValue(as(READ));
    expect((await call()).status).toBeLessThan(300);
    expect(h.writes).toEqual([write, write]);
  });
});

describe("saved-view edits (PATCH, and the legacy PUT)", () => {
  const viewParams = { params: Promise.resolve({ orgId: ORG, viewId: "v1" }) };
  const OWN_VIEW = { id: "v1", orgId: ORG, ownerId: ME, name: "Mine", visibility: "PRIVATE", projectId: null, teamId: null, editors: [] };
  const edits = [
    ["edit", () => editView(req("PATCH", { name: "Renamed" }), viewParams as never)],
    ["edit (legacy PUT)", () => legacyEditView(req("PUT", { name: "Renamed" }), viewParams as never)],
  ] as const;

  it.each(edits)("a read key can't %s its own view", async (_n, call) => {
    h.view = OWN_VIEW;
    h.getAuthContext.mockResolvedValue(as(READ, ["read"]));
    expect((await call()).status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it.each(edits)("an items:write key and an ITEM_READ session get past the gate to %s", async (_n, call) => {
    h.view = OWN_VIEW;
    h.getAuthContext.mockResolvedValue(as(WRITE, ["items:write"]));
    expect((await call()).status).not.toBe(403);
    h.getAuthContext.mockResolvedValue(as(READ));
    expect((await call()).status).not.toBe(403);
  });

  it("an admin's key doesn't load someone else's private view as an administrator", async () => {
    // viewerScope caps an admin's key (isAdmin false); the route must use that,
    // not the raw orgRole, or the key reads and deletes filters it can't see.
    h.view = { ...OWN_VIEW, ownerId: "someone-else" };
    h.canSee = false;
    h.getAuthContext.mockResolvedValue({ ...as(WRITE, ["items:write"]), orgRole: OrgRole.ADMIN });
    expect((await deleteView(req("DELETE"), viewParams as never)).status).toBe(404);
    expect(h.writes).toEqual([]);
  });

  it("the admin's session still does", async () => {
    h.view = { ...OWN_VIEW, ownerId: "someone-else" };
    h.canSee = false;
    h.isAdmin = true;
    h.getAuthContext.mockResolvedValue({ ...as(WRITE), orgRole: OrgRole.ADMIN });
    expect((await deleteView(req("DELETE"), viewParams as never)).status).toBe(204);
  });
});
