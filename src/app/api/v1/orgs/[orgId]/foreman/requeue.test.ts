// @vitest-environment node
//
// Foreman console "requeue" control — the human-triggered equivalent of an
// `@Foreman requeue` mention: pulls a `review`-column ticket back to
// `backlog`. Same real-e2e-DB style as routes.test.ts (only `getAuthContext`
// is mocked; `@/lib/db/client` runs the real queries). Proves:
//   - a `review` item flips to `backlog`, gets a bot comment, and logs a
//     `requeued` foreman_events row;
//   - an item NOT in `review` → 409;
//   - an item belonging to another org → 404 (same code path as "doesn't
//     exist" — the where clause is scoped to `{ id, orgId }`);
//   - a caller without ORG_UPDATE → non-200.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { POST as postRequeue } from "./requeue/route";

let orgId: string;
let userId: string;
let projectId: string;
let workItemTypeId: string;

function ctx(perms: bigint, orgRole: OrgRole = OrgRole.ADMIN): AuthContext {
  return {
    userId,
    orgId,
    orgRole,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
  };
}

function params() {
  return Promise.resolve({ orgId });
}

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/foreman/requeue`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;

  const user = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
    select: { id: true },
  });
  userId = user.id;

  const project = await prisma.project.findFirstOrThrow({ where: { orgId }, select: { id: true } });
  projectId = project.id;

  const type = await prisma.workItemType.findFirstOrThrow({
    where: { OR: [{ orgId }, { orgId: null }] },
    select: { id: true },
  });
  workItemTypeId = type.id;
});

beforeEach(() => {
  getAuthContext.mockResolvedValue(ctx(Permission.ORG_UPDATE));
});

/** Tracks every fixture row created by a test so afterEach can purge it —
 *  scoped tightly (exact ids, not a blanket filter) since this is the shared
 *  e2e DB with parallel file scheduling. */
const cleanup: { itemIds: string[]; orgIds: string[] } = { itemIds: [], orgIds: [] };

afterEach(async () => {
  if (cleanup.itemIds.length > 0) {
    await prisma.comment.deleteMany({ where: { workItemId: { in: cleanup.itemIds } } });
    await prisma.foremanEvent.deleteMany({ where: { workItemId: { in: cleanup.itemIds } } });
    await prisma.workItem.deleteMany({ where: { id: { in: cleanup.itemIds } } });
    cleanup.itemIds = [];
  }
  if (cleanup.orgIds.length > 0) {
    // Cascades org members + projects (both have a real FK `onDelete: Cascade`
    // to organizations) — but NOT work items: `work_items.org_id`/`project_id`
    // are plain denormalized columns with no FK to either table, so a work
    // item never cascade-deletes with its org. Any work item created under a
    // throwaway org here MUST also be queued in `cleanup.itemIds` above.
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } });
    cleanup.orgIds = [];
  }
});

async function createItem(
  columnKey: string,
  target?: { orgId: string; projectId: string; typeId: string },
) {
  const oId = target?.orgId ?? orgId;
  const pId = target?.projectId ?? projectId;
  const tId = target?.typeId ?? workItemTypeId;
  const last = await prisma.workItem.findFirst({
    where: { projectId: pId },
    orderBy: { ticketNumber: "desc" },
    select: { ticketNumber: true },
  });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.workItem.create({
    data: {
      orgId: oId,
      projectId: pId,
      ticketNumber: (last?.ticketNumber ?? 0) + 1,
      title: `[foreman-requeue-test] ${columnKey} ${stamp}`,
      description: "",
      columnKey,
      workItemTypeId: tId,
      createdById: userId,
    },
  });
}

describe("POST /foreman/requeue", () => {
  it("moves a review item back to backlog, posts a bot comment, and logs a requeued event", async () => {
    const item = await createItem("review");
    cleanup.itemIds.push(item.id);

    const res = await postRequeue(req({ workItemId: item.id }), { params: params() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const updated = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.columnKey).toBe("backlog");
    expect(updated.columnEnteredAt).not.toBeNull();

    const comments = await prisma.comment.findMany({ where: { workItemId: item.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.content).toBe("Requeued by Alice from the Foreman console.");
    // No seeded foreman@cosmos.internal bot user in the e2e DB — falls back to
    // the acting user, per the route's documented fallback.
    expect(comments[0]!.authorId).toBe(userId);

    const events = await prisma.foremanEvent.findMany({ where: { workItemId: item.id, kind: "requeued" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("info");
    expect(events[0]!.ticketKey).toBeNull();
    expect(events[0]!.message).toBe("requeued from the Foreman console by Alice");
  });

  it("409s when the item is not in the review column", async () => {
    const item = await createItem("backlog");
    cleanup.itemIds.push(item.id);

    const res = await postRequeue(req({ workItemId: item.id }), { params: params() });
    expect(res.status).toBe(409);

    const untouched = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(untouched.columnKey).toBe("backlog");
  });

  it("404s on a work item id that belongs to a different org", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const foreignOrg = await prisma.organization.create({
      data: { name: `requeue-foreign-${stamp}`, slug: `requeue-foreign-${stamp}` },
    });
    cleanup.orgIds.push(foreignOrg.id);
    const foreignProject = await prisma.project.create({
      data: { orgId: foreignOrg.id, name: "P", key: `RQ${stamp.slice(-4).toUpperCase()}` },
    });
    const foreignType = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const foreignItem = await createItem("review", {
      orgId: foreignOrg.id,
      projectId: foreignProject.id,
      typeId: foreignType.id,
    });
    // work_items has no FK to organizations/projects (see afterEach), so the
    // org cascade below won't reach this row — clean it up explicitly too.
    cleanup.itemIds.push(foreignItem.id);

    const res = await postRequeue(req({ workItemId: foreignItem.id }), { params: params() });
    expect(res.status).toBe(404);
  });

  it("404s on a nonexistent work item id", async () => {
    const res = await postRequeue(
      req({ workItemId: "00000000-0000-0000-0000-000000000000" }),
      { params: params() },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a caller without ORG_UPDATE (non-200)", async () => {
    getAuthContext.mockResolvedValue(ctx(Permission.PROJECT_READ));
    const item = await createItem("review");
    cleanup.itemIds.push(item.id);

    const res = await postRequeue(req({ workItemId: item.id }), { params: params() });
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const untouched = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(untouched.columnKey).toBe("review");
  });

  it("403s a work-role-widened non-admin (ORG_UPDATE permission but base role MEMBER)", async () => {
    // A MEMBER whose work-role grants ORG_UPDATE clears requirePermission, but
    // STEERING the deployer is a BASE OWNER/ADMIN privilege (matches the daemon's
    // privilegedUserIds gate) — so requeue must still 403 with the base-role error.
    getAuthContext.mockResolvedValue(ctx(Permission.ORG_UPDATE, OrgRole.MEMBER));
    const item = await createItem("review");
    cleanup.itemIds.push(item.id);

    const res = await postRequeue(req({ workItemId: item.id }), { params: params() });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("steering the delivery agent requires the Owner or Admin base role");

    const untouched = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(untouched.columnKey).toBe("review");
  });
});
