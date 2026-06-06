// @vitest-environment node
//
// FIRST API route-handler integration test for cosmos-saas. This file
// establishes the harness pattern for testing App Router route handlers in
// isolation (no DB, no HTTP server):
//
//   1. `vi.mock` the I/O boundaries the handler imports — `@/lib/auth/session`
//      (getAuthContext), `@/lib/db/client` (prisma), `@/lib/audit` (logAudit),
//      and any best-effort side-effects (notifications, RAG embeds). The whole
//      module is replaced, so `cache()`-wrapped exports become plain async fns.
//   2. Do NOT mock the authorization engine. `requireAccess` / `evaluateAccess`
//      (in @/lib/abac) are PURE — letting them run against a crafted AuthContext
//      is the whole point: the test exercises the real authz decision.
//   3. Build a `NextRequest` and call the exported handler DIRECTLY, passing the
//      App Router second arg `{ params: Promise.resolve({...}) }`.
//
// Coverage here: the `requireAccess` ABAC gate on the wired work-item route.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Permission, type PermissionKey } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { OrgRole } from "@prisma/client";

// --- I/O boundary mocks ------------------------------------------------------
// `vi.mock` factories are hoisted ABOVE the file's top-level consts, so the mock
// objects must be created in a `vi.hoisted` block (also hoisted) to be in scope.
const { getAuthContext, prisma, logAudit } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  prisma: {
    organization: { findUnique: vi.fn() },
    workItem: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    activity: { createMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  logAudit: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/audit", () => ({ logAudit }));

// Best-effort side-effects the PUT path fires — stub so they don't reach real I/O.
vi.mock("@/lib/notifications/create", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/rag/embed", () => ({ safeEmbedText: vi.fn().mockResolvedValue(null) }));

import { PUT, DELETE } from "./route";

// --- ctx + fixture helpers ---------------------------------------------------
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const ITEM_ID = "33333333-3333-3333-3333-333333333333";
const ACTOR_ID = "44444444-4444-4444-4444-444444444444";

/** Build a permission bitfield from real Permission bits (no magic numbers). */
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

/** An UNCONDITIONAL deny on `action` — fires for everyone, no DB lookup needed
 *  (empty `conditions` = always fires). Keeps the test independent of in_project. */
function unconditionalDeny(action: PermissionKey): AbacRule {
  return { effect: "deny", actions: [action], conditions: [] };
}

function putRequest(body: Record<string, unknown> = { title: "Updated" }): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/projects/p/work-items/i", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function deleteRequest(): NextRequest {
  return new NextRequest("http://localhost/api/v1/orgs/o/projects/p/work-items/i", {
    method: "DELETE",
  });
}

const params = Promise.resolve({ orgId: ORG_ID, projectId: PROJECT_ID, itemId: ITEM_ID });

beforeEach(() => {
  vi.clearAllMocks();
  // org resolves (so the route gets to the auth/authz stage)
  prisma.organization.findUnique.mockResolvedValue({ id: ORG_ID, slug: "acme" });
  // existing work item — created by someone OTHER than the actor (so owns_resource
  // is false and any ownership-conditional policy is irrelevant here).
  prisma.workItem.findFirst.mockResolvedValue({
    id: ITEM_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    title: "Original",
    description: "",
    columnKey: "todo",
    priority: "MEDIUM",
    assigneeId: null,
    cycleId: null,
    workItemTypeId: null,
    createdById: "99999999-9999-9999-9999-999999999999",
    completedAt: null,
    ticketNumber: 7,
  });
  // $transaction runs the callback against a tx that mirrors prisma.
  prisma.$transaction.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => {
    prisma.workItem.update.mockResolvedValue({
      id: ITEM_ID,
      title: "Updated",
      description: "",
    });
    prisma.activity.createMany.mockResolvedValue({ count: 1 });
    return cb(prisma);
  });
  prisma.workItem.delete.mockResolvedValue({ id: ITEM_ID });
  logAudit.mockResolvedValue(undefined);
});

describe("PUT /work-items/[itemId] — ITEM_UPDATE authz (requireAccess)", () => {
  it("(a) ctx WITHOUT ITEM_UPDATE → 403, and never touches the DB write", async () => {
    // MEMBER-ish ctx that can read items but lacks ITEM_UPDATE.
    getAuthContext.mockResolvedValue(ctxWith({ permissions: bits("ITEM_READ") }));

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.workItem.update).not.toHaveBeenCalled();
  });

  it("(b) ctx WITH ITEM_UPDATE and NO policy → success (200)", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("ITEM_READ", "ITEM_UPDATE") }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "work_item.updated", entityId: ITEM_ID }),
    );
  });

  it("(c) ctx WITH ITEM_UPDATE but an UNCONDITIONAL deny on ITEM_UPDATE → 403", async () => {
    // The bit grants it, but a member/work-role deny policy narrows it away.
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("ITEM_READ", "ITEM_UPDATE"),
        abacRules: [unconditionalDeny("ITEM_UPDATE")],
      }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("(d) OWNER with a deny present → still succeeds (break-glass)", async () => {
    // evaluateAccess checks isOwner FIRST, before any rule. OWNER's bitfield
    // includes ITEM_UPDATE via RolePermissions.OWNER.
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: Permission.ITEM_UPDATE | Permission.ITEM_READ,
        abacRules: [unconditionalDeny("ITEM_UPDATE")],
        orgRole: OrgRole.OWNER,
      }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("a deny that references a DIFFERENT action does not narrow ITEM_UPDATE → success", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("ITEM_READ", "ITEM_UPDATE"),
        abacRules: [unconditionalDeny("ITEM_DELETE")],
      }),
    );

    const res = await PUT(putRequest(), { params });

    expect(res.status).toBe(200);
  });
});

describe("DELETE /work-items/[itemId] — ITEM_DELETE authz (requireAccess)", () => {
  it("ctx WITHOUT ITEM_DELETE → 403, never deletes", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("ITEM_READ", "ITEM_UPDATE") }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.workItem.delete).not.toHaveBeenCalled();
  });

  it("ctx WITH ITEM_DELETE and no policy → 204 No Content", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({ permissions: bits("ITEM_READ", "ITEM_DELETE") }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(204);
    expect(prisma.workItem.delete).toHaveBeenCalledWith({ where: { id: ITEM_ID } });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "work_item.deleted" }),
    );
  });

  it("ctx WITH ITEM_DELETE but an unconditional ITEM_DELETE deny → 403", async () => {
    getAuthContext.mockResolvedValue(
      ctxWith({
        permissions: bits("ITEM_READ", "ITEM_DELETE"),
        abacRules: [unconditionalDeny("ITEM_DELETE")],
      }),
    );

    const res = await DELETE(deleteRequest(), { params });

    expect(res.status).toBe(403);
    expect(prisma.workItem.delete).not.toHaveBeenCalled();
  });
});
