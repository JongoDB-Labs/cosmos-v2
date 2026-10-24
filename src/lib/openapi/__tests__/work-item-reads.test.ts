// @vitest-environment node
//
// The work-item reads on contracts (PR3c-1). They authenticate before they
// validate or look anything up: no credential is a 401 that describes nothing,
// and the org-scoped addresses no longer answer 404-vs-401 for an id that
// exists (they used to find the item before authenticating). Filters the
// project list accepted before contracts keep working.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { parseRequest } from "../respond";
import { handleApiError } from "@/lib/api-helpers";

const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  findUnique: vi.fn(),
  workItemFindFirst: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: h.getAuthContext }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    organization: { findUnique: h.findUnique },
    workItem: { findFirst: h.workItemFindFirst },
  },
}));

import { GET as listProjectItems } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { GET as getItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { GET as listActivity } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/activity/route";
import { GET as listComments } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/comments/route";
import { GET as getItemById } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/route";
import { GET as listCommentsById } from "@/app/api/v1/orgs/[orgId]/work-items/[itemId]/comments/route";
import { GET as facets } from "@/app/api/v1/orgs/[orgId]/work-items/facets/route";
import { listProjectWorkItems } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route.contract";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const ROUTES: [string, Handler, Record<string, string>][] = [
  ["GET project work items", listProjectItems as unknown as Handler, { orgId: ORG, projectId: ID }],
  ["GET work item", getItem as unknown as Handler, { orgId: ORG, projectId: ID, itemId: ID }],
  ["GET work item activity", listActivity as unknown as Handler, { orgId: ORG, projectId: ID, itemId: ID }],
  ["GET work item comments", listComments as unknown as Handler, { orgId: ORG, projectId: ID, itemId: ID }],
  ["GET work item by id", getItemById as unknown as Handler, { orgId: ORG, itemId: ID }],
  ["GET work item comments by id", listCommentsById as unknown as Handler, { orgId: ORG, itemId: ID }],
  ["GET work-item facets", facets as unknown as Handler, { orgId: ORG }],
];
const get = (qs = "") => new NextRequest(`http://localhost/x${qs}`);
const nonOrgId = (p: Record<string, string>) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, k === "orgId" ? v : "not-a-uuid"]));

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue({ id: ORG, slug: "acme", settings: {} });
  h.getAuthContext.mockResolvedValue(null);
  h.workItemFindFirst.mockResolvedValue({ projectId: ID });
});

describe("work-item reads authenticate first", () => {
  it.each(ROUTES)("%s: no credential is a 401 that describes nothing", async (_n, handler, params) => {
    const res = await handler(get("?priority=NOPE&assigneeId=bad"), { params: Promise.resolve(params) });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(/issues/);
  });

  it.each(ROUTES.filter(([, , p]) => Object.keys(p).length > 1))(
    "%s: a bad non-org path id is still a 401 without a credential",
    async (_n, handler, params) => {
      expect((await handler(get(), { params: Promise.resolve(nonOrgId(params)) })).status).toBe(401);
    },
  );

  it.each([
    ["GET work item by id", getItemById as unknown as Handler],
    ["GET work item comments by id", listCommentsById as unknown as Handler],
  ])("%s: the item isn't looked up before authentication (no 404-vs-401 oracle)", async (_n, handler) => {
    for (const exists of [true, false]) {
      h.workItemFindFirst.mockResolvedValue(exists ? { projectId: ID } : null);
      expect((await handler(get(), { params: Promise.resolve({ orgId: ORG, itemId: ID }) })).status).toBe(401);
    }
    expect(h.workItemFindFirst).not.toHaveBeenCalled();
  });
});

const list = (qs: string) => parseRequest(listProjectWorkItems, get(`?${qs}`), Promise.resolve({ orgId: ORG, projectId: ID }));
/** The status a route's catch would answer with. */
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => handleApiError(e).status);

describe("the project list's filters, as before contracts", () => {
  it.each([
    "archived=only", "archived=all", "archived=active", "archived=anything", "includeArchived=1", "includeArchived=yes",
    "assigneeId=", "intervalId=&parentId=&workItemTypeId=", "priority=", "priority=HIGH", "columnKey=todo&search=login",
    `assigneeId=${ID}`, "_=12345",
  ])("?%s is accepted", async (qs) => {
    expect(await status(list(qs))).toBe(200);
  });

  it.each([
    ["search=a&search=b", { search: "a" }],
    [`assigneeId=${ID}&assigneeId=bad`, { assigneeId: ID }],
    ["priority=HIGH&priority=LOW", { priority: "HIGH" }],
    ["archived=only&archived=all", { archived: "only" }],
  ])("a repeated ?%s reads as its first value, as searchParams.get() did", async (qs, want) => {
    expect((await list(qs)).query).toMatchObject(want);
  });

  it.each(["assigneeId=bad", "intervalId=123", "priority=NOPE"])(
    "?%s is a 400 (it used to reach Prisma and fail as a 500)",
    async (qs) => {
      expect(await status(list(qs))).toBe(400);
    },
  );
});
