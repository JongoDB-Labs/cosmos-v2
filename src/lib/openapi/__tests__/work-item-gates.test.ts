// @vitest-environment node
//
// The project visibility gate on the work-item reads (ops' #1144 review). For
// a signed-in caller whose project gate refuses, each route answers without
// loading anything: 403 on the project-scoped addresses, and on the org-scoped
// ones the same 404 as a missing id (so a caller can't probe which ids exist).
// The org-scoped ones gate on the item's REAL project with the right action.
// Comments carry only what anyone may read, and the detail embeds them only
// for a caller who may read comments.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { ORG, PATH_PROJECT, REAL_PROJECT, ITEM } = vi.hoisted(() => ({
  ORG: "11111111-1111-4111-8111-111111111111",
  PATH_PROJECT: "22222222-2222-4222-8222-222222222222",
  REAL_PROJECT: "44444444-4444-4444-8444-444444444444",
  ITEM: "33333333-3333-4333-8333-333333333333",
}));

const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  requireProjectRead: vi.fn(),
  loads: [] as string[],
  findFirstArgs: [] as unknown[],
  commentWhere: [] as unknown[],
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/rbac/require-project-read", () => ({ requireProjectRead: h.requireProjectRead }));
// Moderation rights aren't under test here.
vi.mock("@/lib/rbac/scope", async (orig) => ({
  ...(await orig<typeof import("@/lib/rbac/scope")>()),
  canManageProject: async () => false,
}));
vi.mock("@/lib/db/client", async () => {
  const { workItemRow } = await import("@/lib/openapi/testing/rows");
  const load = (name: string, value: unknown) => async (args?: unknown) => {
    h.loads.push(name);
    if (name === "workItem.findFirst") h.findFirstArgs.push(args);
    if (name === "comment.findMany") h.commentWhere.push((args as { where: unknown }).where);
    return value;
  };
  const row: Record<string, unknown> = { ...workItemRow({ id: ITEM, orgId: ORG, projectId: REAL_PROJECT }) };
  delete row.searchVector;
  return {
    prisma: {
      organization: { findUnique: async () => ({ id: ORG, slug: "acme", settings: {}, tenantClass: "STANDARD" }) },
      project: { findFirst: load("project.findFirst", { id: PATH_PROJECT, orgId: ORG }), findMany: load("project.findMany", []) },
      workItem: {
        findMany: load("workItem.findMany", []),
        findFirst: async (args: { select?: { projectId?: boolean }; include?: { comments?: unknown } }) => {
          h.loads.push("workItem.findFirst");
          h.findFirstArgs.push(args);
          if (args?.select?.projectId) return { projectId: REAL_PROJECT };
          return {
            ...row, parent: null, children: [], assignees: [], activities: [], interval: null,
            workItemType: { id: ITEM, key: "software.task", name: "Task", icon: null, color: null },
            ...(args?.include?.comments ? { comments: [] } : {}),
          };
        },
      },
      activity: { findMany: load("activity.findMany", []) },
      comment: { findMany: load("comment.findMany", []) },
      user: { findMany: load("user.findMany", []) },
    },
  };
});

import { GET as listProjectItems } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { GET as getItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { GET as listActivity } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/activity/route";
import { GET as listComments } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/route";
import { GET as getItemById } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/route";
import { GET as listCommentsById } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/comments/route";
import { GET as facets } from "@/app/api/v1/orgs/[orgId]/work-items/facets/route";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const call = (handler: unknown, params: Record<string, string>) =>
  (handler as Handler)(new NextRequest("http://localhost/x"), { params: Promise.resolve(params) });
const member = (permissions: bigint = Permission.ITEM_READ | Permission.COMMENT_READ | Permission.PROJECT_READ): AuthContext => ({
  userId: "u1", orgId: ORG, orgRole: OrgRole.MEMBER, permissions, basePermissions: permissions, abacRules: [],
});
const refuse = async () => { throw new ForbiddenError("not your project"); };

beforeEach(() => {
  vi.clearAllMocks();
  h.loads.length = 0;
  h.findFirstArgs.length = 0;
  h.commentWhere.length = 0;
  h.getAuthContext.mockResolvedValue(member());
  h.requireProjectRead.mockImplementation(refuse);
});

describe("a refused project gate loads nothing", () => {
  it.each([
    ["list", listProjectItems, { orgId: ORG, projectId: PATH_PROJECT }],
    ["get", getItem, { orgId: ORG, projectId: PATH_PROJECT, itemId: ITEM }],
    ["activity", listActivity, { orgId: ORG, projectId: PATH_PROJECT, itemId: ITEM }],
    ["comments", listComments, { orgId: ORG, projectId: PATH_PROJECT, itemId: ITEM }],
  ] as const)("project-scoped %s: 403, nothing read", async (_n, handler, params) => {
    expect((await call(handler, params)).status).toBe(403);
    expect(h.loads).toEqual([]);
  });

  it.each([
    ["getById", getItemById, "ITEM_READ"],
    ["commentsById", listCommentsById, "COMMENT_READ"],
  ] as const)("org-scoped %s: the same 404 as a missing id, gated on the item's own project", async (_n, handler, action) => {
    const res = await call(handler, { orgId: ORG, itemId: ITEM });
    expect(res.status).toBe(404);
    expect(h.requireProjectRead).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), REAL_PROJECT, action);
    // Only the lookup of the item's project; no detail, no thread.
    expect(h.loads).toEqual(["workItem.findFirst"]);
  });

  it("facets: a caller without ITEM_READ gets 403 and nothing is read", async () => {
    h.getAuthContext.mockResolvedValue(member(Permission.PROJECT_READ));
    expect((await call(facets, { orgId: ORG })).status).toBe(403);
    expect(h.loads).toEqual([]);
  });
});

describe("comments carry only what anyone may read", () => {
  beforeEach(() => h.requireProjectRead.mockResolvedValue(undefined));

  it("the thread asks for public, undeleted, unhidden comments within the marking ceiling", async () => {
    expect((await call(listComments, { orgId: ORG, projectId: PATH_PROJECT, itemId: ITEM })).status).toBe(200);
    expect(h.commentWhere[0]).toMatchObject({
      visibility: "PUBLIC",
      deletedAt: null,
      hiddenAt: null,
      OR: [{ classification: null }, { classification: { in: expect.any(Array) } }],
    });
  });

  it("the detail embeds comments with the same filter for a caller who may read them", async () => {
    expect((await call(getItem, { orgId: ORG, projectId: PATH_PROJECT, itemId: ITEM })).status).toBe(200);
    const include = (h.findFirstArgs.at(-1) as { include: { comments: { where: unknown } } }).include;
    expect(include.comments.where).toMatchObject({ visibility: "PUBLIC", deletedAt: null, hiddenAt: null });
  });

  it("the detail embeds no comments for a caller without COMMENT_READ, and asked with that action", async () => {
    h.requireProjectRead.mockImplementation(async (_c: unknown, _p: string, action: string) => {
      if (action === "COMMENT_READ") throw new ForbiddenError("no comments");
    });
    const res = await call(getItem, { orgId: ORG, projectId: PATH_PROJECT, itemId: ITEM });
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toEqual([]);
    expect(h.requireProjectRead).toHaveBeenCalledWith(expect.anything(), PATH_PROJECT, "COMMENT_READ");
    expect((h.findFirstArgs.at(-1) as { include: { comments: unknown } }).include.comments).toBe(false);
  });
});
