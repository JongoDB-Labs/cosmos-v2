// @vitest-environment node
//
// Route-handler integration test for the ORG-WIDE Issues search (JQL-lite).
// Follows the harness pattern established in
// projects/[projectId]/work-items/[itemId]/route.test.ts:
//
//   1. vi.mock ONLY the I/O boundaries — @/lib/auth/session (getAuthContext) and
//      @/lib/db/client (prisma). The whole module is replaced.
//   2. Do NOT mock the authorization seam. `getReadableProjectIds` (scope.ts)
//      and the pure `evaluateAccess` engine run for real against a crafted
//      AuthContext + crafted prisma rows — exercising the REAL per-project
//      narrowing, which is the whole point of this fix.
//   3. Build a NextRequest and call the exported GET handler directly.
//
// Coverage here: the regression fix for the resource-less org gate. An actor
// with an `in_project` ITEM_READ DENY must NOT get a hard 403 on the whole
// Issues page (the old `requireAccess(ctx, "ITEM_READ")` with no projectId
// failed the in_project deny CLOSED). Instead the route gates on the raw
// ITEM_READ bit and lets getReadableProjectIds fold the per-project deny in.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
const { getAuthContext, prisma } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    project: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findMany: vi.fn() },
    workItem: { findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET, POST } from "./route";

// --- fixtures ----------------------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";
const MEMBER_OBJ_ID = "55555555-5555-5555-5555-555555555555";
const P_MEMBER = "22222222-2222-2222-2222-222222222222"; // actor IS a member
const P_OTHER = "33333333-3333-3333-3333-333333333333"; // actor is NOT a member
const TYPE_ID = "66666666-6666-6666-6666-666666666666";
// Work-item ids are UUIDs, as the search's response contract requires.
const ITEM_MEM = "77777777-7777-7777-7777-777777777771";
const ITEM_OTHER = "77777777-7777-7777-7777-777777777772";

function bits(...keys: PermissionKey[]): bigint {
  return keys.reduce((acc, k) => acc | Permission[k], 0n);
}

function ctxWith(opts: {
  permissions: bigint;
  abacRules?: AbacRule[];
  orgRole?: OrgRole;
}): AuthContext {
  return {
    userId: ACTOR_ID,
    orgId: ORG_ID,
    orgRole: opts.orgRole ?? OrgRole.MEMBER,
    permissions: opts.permissions,
    basePermissions: opts.permissions,
    abacRules: opts.abacRules ?? [],
  };
}

/** A `restrict-by-membership`-style ITEM_READ deny conditioned on in_project.
 *  Engine semantics (see abac/engine.test.ts): in_project resolved TRUE → deny
 *  fires (project denied); FALSE → allowed; UNRESOLVED → fires (fail-closed).
 *  At the resource-less org gate in_project is unresolvable → the deny would
 *  fire → 403 the WHOLE page (the bug). getReadableProjectIds resolves it
 *  per-project instead. */
function inProjectItemReadDeny(): AbacRule {
  return { effect: "deny", actions: ["ITEM_READ"], conditions: [{ rel: "in_project" }] };
}

function getRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/work-items/search${qs}`);
}

const params = Promise.resolve({ orgId: ORG_ID });

/** Make the work-item row prisma returns for the readable project. */
function workItemRow(projectId: string, id: string, ticketNumber: number) {
  return {
    id,
    ticketNumber,
    title: `Item ${ticketNumber}`,
    columnKey: "todo",
    priority: "MEDIUM",
    assigneeId: null,
    parentId: null,
    intervalId: null,
    storyPoints: null,
    tags: [],
    highlight: null,
    archivedAt: null,
    startDate: null,
    dueDate: null,
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    projectId,
    workItemType: { id: TYPE_ID, key: "task", name: "Task", icon: null, color: null },
    assignees: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // Two projects exist in the org.
  prisma.project.findMany.mockImplementation(async (arg: { where?: { id?: { in?: string[] } } }) => {
    // getReadableProjectIds: list every project in the org (no id filter).
    if (!arg?.where?.id?.in) {
      return [{ id: P_MEMBER }, { id: P_OTHER }];
    }
    // runWorkItemQuery: resolve project labels for the matched ids.
    const ids = arg.where.id.in;
    return [
      { id: P_MEMBER, key: "MEM", name: "Member Project" },
      { id: P_OTHER, key: "OTH", name: "Other Project" },
    ].filter((p) => ids.includes(p.id));
  });
  // Actor's membership lookups (only hit when a relevant in_project rule exists).
  prisma.orgMember.findUnique.mockResolvedValue({ id: MEMBER_OBJ_ID });
  prisma.projectMember.findMany.mockResolvedValue([{ projectId: P_MEMBER }]);
  prisma.user.findMany.mockResolvedValue([]);
});

describe("GET /work-items/search — org-wide ITEM_READ gate (resource-less)", () => {
  it("no ITEM_READ bit at all → 403 (the raw-bit org gate still blocks)", async () => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("PROJECT_READ") }));

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("ITEM_READ bit + in_project ITEM_READ deny, member of one project → NOT a 403; returns scoped items", async () => {
    // The regression: with the old requireAccess(ITEM_READ) gate, this actor's
    // in_project deny was unresolvable at the org level (no projectId) and fired
    // CLOSED → a hard 403 on the whole Issues page. Now we gate on the raw bit
    // and let getReadableProjectIds narrow per-project.
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("ITEM_READ"),
        abacRules: [inProjectItemReadDeny()],
      }),
    );
    // Engine semantics: in_project deny fires on the MEMBER project (denied) and
    // is allowed on the OTHER project → the readable set is exactly [P_OTHER].
    // The query is therefore hard-scoped to P_OTHER; return one item from it.
    prisma.workItem.findMany.mockResolvedValue([
      workItemRow(P_OTHER, ITEM_OTHER, 1),
    ]);
    prisma.workItem.count.mockResolvedValue(1);

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200); // critically: NOT 403
    const body = (await res.json()) as { data: { id: string; project: { id: string } }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data.map((r) => r.id)).toEqual([ITEM_OTHER]);

    // The where-clause that hit the DB was hard-scoped to the readable set
    // (folding the in_project deny) — never the actor's denied member project.
    const whereArg = prisma.workItem.findMany.mock.calls[0][0].where;
    expect(whereArg.projectId).toEqual({ in: [P_OTHER] });
    expect(whereArg.projectId.in).not.toContain(P_MEMBER);
  });

  it("ITEM_READ bit + UNCONDITIONAL ITEM_READ deny on every project → empty readable set → {data:[],total:0}, not 403", async () => {
    // An unconditional ITEM_READ deny fires for every project → readable set is
    // empty. The route returns an empty envelope (the short-circuit), never a 403
    // and never a DB query for items.
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("ITEM_READ"),
        abacRules: [{ effect: "deny", actions: ["ITEM_READ"], conditions: [] }],
      }),
    );

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; total: number };
    expect(body).toEqual({ data: [], total: 0 });
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("OWNER with an in_project ITEM_READ deny present → break-glass: sees items across all projects, no 403", async () => {
    // getReadableProjectIds break-glasses OWNER to every project before any
    // policy evaluation; the raw-bit gate passes (OWNER has all bits).
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("ITEM_READ"),
        abacRules: [inProjectItemReadDeny()],
        orgRole: OrgRole.OWNER,
      }),
    );
    prisma.workItem.findMany.mockResolvedValue([
      workItemRow(P_MEMBER, ITEM_MEM, 1),
      workItemRow(P_OTHER, ITEM_OTHER, 2),
    ]);
    prisma.workItem.count.mockResolvedValue(2);

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    const whereArg = prisma.workItem.findMany.mock.calls[0][0].where;
    // Both projects in scope for the owner.
    expect(new Set(whereArg.projectId.in)).toEqual(new Set([P_MEMBER, P_OTHER]));
  });
});

function postRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/work-items/search`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /work-items/search — filter keys the body used to lose", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ITEM_READ") }));
    prisma.workItem.findMany.mockResolvedValue([]);
    prisma.workItem.count.mockResolvedValue(0);
  });

  it("archived, ids and the caller's own watchedByUserId all reach the where-clause", async () => {
    const res = await POST(
      postRequest({ filter: { archived: "only", ids: ["item-1"], watchedByUserId: ACTOR_ID } }),
      { params },
    );

    expect(res.status).toBe(200);
    const where = prisma.workItem.findMany.mock.calls[0][0].where;
    expect(where.archivedAt).toEqual({ not: null });
    expect(where.id).toEqual({ in: ["item-1"] });
    expect(where.watchers).toEqual({ some: { userId: ACTOR_ID } });
  });

  it("someone else's watch list → 400, and nothing is queried", async () => {
    const res = await POST(
      postRequest({ filter: { watchedByUserId: "99999999-9999-9999-9999-999999999999" } }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("an unknown filter key → 400 instead of an unfiltered page", async () => {
    const res = await POST(postRequest({ filter: { includeArchived: true } }), { params });

    expect(res.status).toBe(400);
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });
});

describe("the search on its public contract", () => {
  beforeEach(() => {
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ITEM_READ") }));
    prisma.workItem.findMany.mockResolvedValue([workItemRow(P_OTHER, ITEM_OTHER, 7)]);
    prisma.workItem.count.mockResolvedValue(1);
  });
  const get = (qs: string) => new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/work-items/search?${qs}`);

  it("an unknown parameter is a problem+json 400 naming it, and nothing is queried", async () => {
    const res = await GET(get("limit=5&project=" + P_OTHER), { params });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(body).toMatchObject({ code: "invalid_request", error: "Unknown query parameter" });
    expect(body.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["limit"] });
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("the bare collection path answers exactly what the search does", async () => {
    const { GET: listGet } = await import("../route");
    const qs = `project=${P_OTHER}&pageSize=5`;
    const viaSearch = await (await GET(get(qs), { params })).json();
    const viaList = await listGet(new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/work-items?${qs}`), { params });

    expect(viaList.status).toBe(200);
    expect(await viaList.json()).toEqual(viaSearch);
    expect(viaSearch.data[0]).toMatchObject({ id: ITEM_OTHER, ticketKey: "OTH-7", project: { id: P_OTHER } });
  });

  it("a row is exactly the documented WorkItemSearchRow, nothing more", async () => {
    const { WorkItemSearchRow } = await import("@/lib/openapi/schemas/work-item-query");
    const body = await (await GET(get(""), { params })).json();

    expect(Object.keys(body.data[0]).sort()).toEqual(Object.keys(WorkItemSearchRow.shape).sort());
  });

  it("POST with a body that isn't JSON is a 400, not an unfiltered page", async () => {
    const req = new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/work-items/search`, {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req, { params });

    expect(res.status).toBe(400);
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });

  it("an API key without `read` is refused on both GET paths and the POST", async () => {
    getAuthContext.mockResolvedValue({ ...ctxWith({ permissions: bits("ITEM_READ") }), isApiKey: true, scopes: ["members:read"] });
    const { GET: listGet } = await import("../route");

    for (const res of [
      await GET(get(""), { params }),
      await listGet(new NextRequest(`http://localhost/api/v1/orgs/${ORG_ID}/work-items`), { params }),
      await POST(postRequest({}), { params }),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("insufficient_scope");
    }
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();
  });
});
