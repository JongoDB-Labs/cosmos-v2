// @vitest-environment node
//
// Assigning people to a work item tells each of them, through every door that
// assigns: the item's own PUT (one assignee, or the whole set as the detail
// sheet sends it), the bulk route (Assign to, the board's bulk bar) and Cosmo's
// tools. Only people the change newly puts on the item hear about it: never
// whoever made the change, and never someone already assigned. Whether the
// person may read the item stays createNotification's call (see
// notifications/recipient-visibility.db.test.ts); one case here shows that a
// set is held to it too.
//
// Own org and own users; the seeded ones are never touched.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { memberToolCtx } from "@/lib/testing/tool-auth";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/notifications/push", () => ({ pushToUser: async () => undefined }));

const { PUT: putItem } = await import("@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route");
const { PUT: putBulk } = await import("@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route");
const { updateWorkItem } = await import("@/lib/ai/executors/work-items");
const { bulkUpdateWorkItems } = await import("@/lib/ai/executors/bulk");

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", restrictedId = "", typeId = "";
const ids: Record<string, string> = {};
const names = new Map<string, string>();

beforeAll(async () => {
  for (const n of ["actor", "ann", "ben", "cat", "dee"]) {
    const u = await prisma.user.create({ data: { email: `${n}-${stamp}@assign.test`, displayName: n } });
    ids[n] = u.id;
    names.set(u.id, n);
  }
  orgId = (await prisma.organization.create({ data: { name: `assign ${stamp}`, slug: `assign-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ids.actor, role: "OWNER", permissions: "0" } });
  const members: Record<string, string> = {};
  for (const n of ["ann", "ben", "cat", "dee"]) {
    members[n] = (await prisma.orgMember.create({ data: { orgId, userId: ids[n], role: "MEMBER", permissions: "0" } })).id;
  }
  const key = `AS${stamp.slice(0, 3).toUpperCase()}`;
  projectId = (await prisma.project.create({ data: { orgId, name: "Open", key } })).id;
  // Team-scoped: ann is on it, dee isn't.
  restrictedId = (await prisma.project.create({ data: { orgId, name: "Restricted", key: `${key}R`, teamScopedAccess: true } })).id;
  await prisma.projectMember.create({ data: { projectId: restrictedId, orgMemberId: members.ann } });
  await ensureFixtureStatuses(projectId);
  await ensureFixtureStatuses(restrictedId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } }).catch(() => undefined);
});

beforeEach(() => {
  h.ctx = { userId: ids.actor, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] } satisfies AuthContext;
});

const item = async (pid = projectId) =>
  (await createFixtureWorkItem({ orgId, projectId: pid, workItemTypeId: typeId, createdById: ids.actor, title: "Quarterly plan", columnKey: "todo" })).id;
const json = (body: unknown) =>
  new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

async function put(itemId: string, body: unknown, pid = projectId) {
  const res = await putItem(json(body), { params: Promise.resolve({ orgId, projectId: pid, itemId }) });
  expect(res.status).toBe(200);
}
async function bulk(itemIds: string[], update: unknown) {
  const res = await putBulk(json({ ids: itemIds, update }), { params: Promise.resolve({ orgId, projectId }) });
  expect(res.status).toBe(200);
}
/** The item's assignees, by name, in order. */
const setOf = async (itemId: string) =>
  (await prisma.workItemAssignee.findMany({ where: { workItemId: itemId }, orderBy: { sortOrder: "asc" }, select: { userId: true } }))
    .map((a) => names.get(a.userId));
/** Who is on the item, by name, sorted: for when two were moved to the front (a tie). */
const onIt = async (itemId: string) => (await setOf(itemId)).sort();
/** How many assignment notices each person has about `itemId`, by name. */
async function told(itemId: string) {
  const rows = await prisma.notification.findMany({ where: { orgId, type: "work_item.assigned", refId: itemId }, select: { userId: true } });
  const out: Record<string, number> = {};
  for (const r of rows) {
    const n = names.get(r.userId) ?? r.userId;
    out[n] = (out[n] ?? 0) + 1;
  }
  return out;
}

describe("assignment notices (e2e DB)", () => {
  it("giving an item a set of assignees tells each one newly added, and not the person who made the change or anyone already on it", async () => {
    const id = await item();
    await put(id, { assigneeIds: [ids.ben] });
    expect(await told(id)).toEqual({ ben: 1 });

    await put(id, { assigneeIds: [ids.actor, ids.ann, ids.ben] });
    expect(await setOf(id)).toEqual(["actor", "ann", "ben"]);
    expect(await told(id)).toEqual({ ann: 1, ben: 1 });

    // Ben taken off and Cat put on: only Cat is new.
    await put(id, { assigneeIds: [ids.ann, ids.cat] });
    expect(await setOf(id)).toEqual(["ann", "cat"]);
    expect(await told(id)).toEqual({ ann: 1, ben: 1, cat: 1 });
  });

  it("one assignee: someone new is told, someone already on the item who is moved to the front is not", async () => {
    const id = await item();
    await put(id, { assigneeIds: [ids.ann, ids.ben] });
    expect(await told(id)).toEqual({ ann: 1, ben: 1 });

    await put(id, { assigneeId: ids.ben });
    expect(await setOf(id)).toEqual(["ben", "ann"]);
    expect(await told(id)).toEqual({ ann: 1, ben: 1 });

    await put(id, { assigneeId: ids.cat });
    await put(id, { assigneeId: ids.actor });
    expect(await onIt(id)).toEqual(["actor", "ann", "ben", "cat"]);
    expect(await told(id)).toEqual({ ann: 1, ben: 1, cat: 1 });
  });

  it("an item assigned before assignee sets existed counts its assignee as already on it", async () => {
    const id = await item();
    // Only the single assignee column, with no set row: how items were stored before.
    await prisma.workItem.update({ where: { id }, data: { assigneeId: ids.ann } });
    expect(await setOf(id)).toEqual([]);

    await put(id, { assigneeId: ids.ann });
    await put(id, { assigneeIds: [ids.ann, ids.ben] });
    expect(await setOf(id)).toEqual(["ann", "ben"]);
    expect(await told(id)).toEqual({ ben: 1 });
  });

  it("bulk Assign to tells, on each item, only the people new on that item", async () => {
    const [one, two] = [await item(), await item()];
    await put(one, { assigneeIds: [ids.ann, ids.ben] });
    expect(await told(one)).toEqual({ ann: 1, ben: 1 });

    // The bulk route takes one assignee. Ben: already on the first item (behind Ann), new on the second.
    await bulk([one, two], { assigneeId: ids.ben });
    expect(await setOf(one)).toEqual(["ben", "ann"]);
    expect(await setOf(two)).toEqual(["ben"]);
    expect(await told(one)).toEqual({ ann: 1, ben: 1 });
    expect(await told(two)).toEqual({ ben: 1 });

    await bulk([one, two], { assigneeId: ids.cat });
    expect(await told(one)).toEqual({ ann: 1, ben: 1, cat: 1 });
    expect(await told(two)).toEqual({ ben: 1, cat: 1 });
  });

  it("Cosmo's tools tell the same people as the app", async () => {
    const cosmo = await memberToolCtx(orgId, ids.actor);
    const ok = (out: unknown) => expect(out).not.toHaveProperty("error");
    const [one, two] = [await item(), await item()];
    ok(await updateWorkItem({ itemId: one, assigneeId: ids.ann }, cosmo));
    ok(await updateWorkItem({ itemId: one, assigneeId: ids.ben }, cosmo));
    // Ann is still on it, behind Ben: moving her back to the front is not news.
    ok(await updateWorkItem({ itemId: one, assigneeId: ids.ann }, cosmo));
    expect(await onIt(one)).toEqual(["ann", "ben"]);
    expect(await told(one)).toEqual({ ann: 1, ben: 1 });

    ok(await bulkUpdateWorkItems({ ids: [one, two], assigneeId: ids.cat }, cosmo));
    // Ann: already on the first item, new on the second.
    ok(await bulkUpdateWorkItems({ ids: [one, two], assigneeId: ids.ann }, cosmo));
    expect(await onIt(two)).toEqual(["ann", "cat"]);
    expect(await told(one)).toEqual({ ann: 1, ben: 1, cat: 1 });
    expect(await told(two)).toEqual({ ann: 1, cat: 1 });
  });

  it("a set reaches only the assignees who can read the item", async () => {
    const id = await item(restrictedId);
    await put(id, { assigneeIds: [ids.ann, ids.dee] }, restrictedId);
    // Both assigned; only the one on the project was told.
    expect(await setOf(id)).toEqual(["ann", "dee"]);
    expect(await told(id)).toEqual({ ann: 1 });
  });
});
