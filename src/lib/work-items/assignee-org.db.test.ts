// @vitest-environment node
//
// Every assignee must be a member of the item's org. Before, a plain update
// (not a workflow transition) and the create route took any user id: a user
// from another org was assigned (a cross-tenant write), and an id that didn't
// exist was a 500 (an oracle for which users exist on the platform). Now both
// get the SAME 422 assignee_not_in_org, through every path that names an assignee. Against a real
// database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { scopeMask } from "@/lib/auth/api-key";
import { handleApiError } from "@/lib/api-helpers";
import { createFixtureWorkItem } from "@/lib/testing/db-fixtures";
import { applyWorkItemChange } from "./apply-change.server";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as createItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { PUT as updateItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { PUT as bulkUpdate } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";
import { updateWorkItem as aiUpdateWorkItem } from "@/lib/ai/executors/work-items";
import { PATCH as editAction } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/actions/[actionId]/route";
import { POST as promoteAction } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/actions/[actionId]/promote/route";

const stamp = Math.random().toString(36).slice(2, 8);
const NO_SUCH_USER = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
let orgId = "", projectId = "", typeId = "", owner = "", colleague = "", outsider = "", leaver = "", dormant = "", itemId = "";

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `owner-${stamp}@assignee.test`, displayName: "Owner" } })).id;
  colleague = (await prisma.user.create({ data: { email: `colleague-${stamp}@assignee.test`, displayName: "Colleague" } })).id;
  outsider = (await prisma.user.create({ data: { email: `outsider-${stamp}@assignee.test`, displayName: "Outsider" } })).id;
  leaver = (await prisma.user.create({ data: { email: `leaver-${stamp}@assignee.test`, displayName: "Leaver" } })).id;
  dormant = (await prisma.user.create({ data: { email: `dormant-${stamp}@assignee.test`, displayName: "Dormant", deactivatedAt: new Date() } })).id;
  orgId = (await prisma.organization.create({ data: { name: `asg ${stamp}`, slug: `asg-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId, userId: colleague, role: "MEMBER", permissions: "0" } });
  // Left the org: the membership row is kept, with removedAt set.
  await prisma.orgMember.create({ data: { orgId, userId: leaver, role: "MEMBER", permissions: "0", removedAt: new Date() } });
  // Still a member, but the account is deactivated.
  await prisma.orgMember.create({ data: { orgId, userId: dormant, role: "MEMBER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "A", key: `AS${stamp.slice(0, 3).toUpperCase()}` } })).id;
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  itemId = (await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title: "t", columnKey: "todo" })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, colleague, outsider, leaver, dormant] } } }).catch(() => undefined);
});

/** A response's status and problem body, minus the per-request id. */
async function answer(res: Response) {
  const body = await res.json();
  delete body.requestId;
  return { status: res.status, body };
}
const change = (patch: Record<string, unknown>) =>
  prisma.$transaction((tx) =>
    applyWorkItemChange(tx, { actorId: owner, orgId, projectId, itemIds: [itemId], patch, source: "API", actor: null }),
  ).then(() => ({ status: 200, body: {} }), (e) => answer(handleApiError(e)));

describe("the change service holds every assignee to the org", () => {
  it("an unknown id and a user from elsewhere get the same 422, and nothing is assigned", async () => {
    const unknown = await change({ assigneeId: NO_SUCH_USER });
    const foreign = await change({ assigneeId: outsider });
    expect(unknown.status).toBe(422);
    expect(foreign).toEqual(unknown);
    expect(unknown.body).toMatchObject({ code: "assignee_not_in_org", detail: "That person isn't a member of this organization." });
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: itemId } })).assigneeId).toBeNull();
    expect(await prisma.workItemAssignee.count({ where: { workItemId: itemId } })).toBe(0);
  });

  it("someone who left the org, or whose account is deactivated, gets that same 422", async () => {
    const unknown = await change({ assigneeId: NO_SUCH_USER });
    for (const id of [leaver, dormant]) {
      expect(await change({ assigneeId: id }), id).toEqual(unknown);
      expect((await change({ assigneeIds: [colleague, id] })).status, id).toBe(422);
    }
    expect(await prisma.workItemAssignee.count({ where: { workItemId: itemId } })).toBe(0);
  });

  it("an outsider hidden in an assignee set is refused too", async () => {
    expect((await change({ assigneeIds: [colleague, outsider] })).status).toBe(422);
  });

  it("an org member is assigned, and unassigning still works", async () => {
    expect((await change({ assigneeId: colleague })).status).toBe(200);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: itemId } })).assigneeId).toBe(colleague);
    expect((await change({ assigneeId: null })).status).toBe(200);
  });
});

const ownerSession = (): AuthContext => ({ userId: owner, orgId, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [] });
/** The owner's items:write key, limited to `projectId`. */
const scopedKey = (): AuthContext => ({
  ...ownerSession(), permissions: scopeMask(["items:write"]), basePermissions: scopeMask(["items:write"]),
  isApiKey: true, scopes: ["items:write"], projectScope: [projectId],
});
const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("the routes", () => {
  it("create: an unknown id and an outsider get the same 422; an org member is created", async () => {
    h.ctx = ownerSession();
    const params = { params: Promise.resolve({ orgId, projectId }) };
    const unknown = await answer(await createItem(json("POST", { title: "x", columnKey: "todo", assigneeId: NO_SUCH_USER }), params));
    const foreign = await answer(await createItem(json("POST", { title: "x", columnKey: "todo", assigneeIds: [outsider] }), params));
    expect(unknown.status).toBe(422);
    expect(foreign).toEqual(unknown);
    const ok = await createItem(json("POST", { title: "x", columnKey: "todo", assigneeId: colleague }), params);
    expect(ok.status).toBe(201);
  });

  it("update with a project-scoped key: 'no such user' and 'not in this org' look the same; a colleague with no tie to the project is assignable", async () => {
    h.ctx = scopedKey();
    const params = { params: Promise.resolve({ orgId, projectId, itemId }) };
    const unknown = await answer(await updateItem(json("PUT", { assigneeId: NO_SUCH_USER }), params));
    const foreign = await answer(await updateItem(json("PUT", { assigneeId: outsider }), params));
    expect(unknown.status).toBe(422);
    expect(foreign).toEqual(unknown);
    // The colleague is on no project at all, so on nothing the key can see; still assignable by id.
    expect((await updateItem(json("PUT", { assigneeId: colleague }), params)).status).toBe(200);
  });
});

describe("bulk and the assistant", () => {
  it("bulk update: an unknown id and an outsider get the same 422, and no item is assigned", async () => {
    h.ctx = ownerSession();
    const second = (await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title: "u", columnKey: "todo" })).id;
    const params = { params: Promise.resolve({ orgId, projectId }) };
    const unknown = await answer(await bulkUpdate(json("PUT", { ids: [itemId, second], update: { assigneeId: NO_SUCH_USER } }), params));
    const foreign = await answer(await bulkUpdate(json("PUT", { ids: [itemId, second], update: { assigneeId: outsider } }), params));
    expect(unknown.status).toBe(422);
    expect(foreign).toEqual(unknown);
    expect(await prisma.workItem.count({ where: { id: { in: [itemId, second] }, assigneeId: { in: [outsider, NO_SUCH_USER] } } })).toBe(0);
  });

  it("the assistant's update_work_item refuses an unknown id and an outsider alike, assigning no one", async () => {
    const tool = { orgId, userId: owner, auth: ownerSession() };
    const unknown = await aiUpdateWorkItem({ itemId, assigneeId: NO_SUCH_USER }, tool);
    const foreign = await aiUpdateWorkItem({ itemId, assigneeId: outsider }, tool);
    expect(unknown).toHaveProperty("error");
    expect(foreign).toEqual(unknown);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: itemId } })).assigneeId).not.toBe(outsider);
  });
});

describe("retro action owners, who become assignees on promote", () => {
  let intervalId = "", ceremonyId = "";
  beforeAll(async () => {
    const board = await prisma.board.create({
      data: { orgId, projectId, name: "Delivery", type: "KANBAN", columns: { create: [{ key: "todo", name: "To do", category: "TODO", sortOrder: 0 }] } },
    });
    intervalId = (await prisma.interval.create({
      data: { orgId, projectId, number: 1, name: "S1", startDate: new Date(), endDate: new Date() },
    })).id;
    ceremonyId = (await prisma.sprintCeremony.create({ data: { orgId, boardId: board.id, intervalId, kind: "REVIEW" } })).id;
  });
  const action = (ownerId: string | null) => prisma.retroActionItem.create({ data: { ceremonyId, text: "do it", ownerId } });
  const at = (actionId: string) => ({ params: Promise.resolve({ orgId, projectId, intervalId, actionId }) });

  it("editing an action can't make an outsider (or an unknown id) its owner", async () => {
    h.ctx = ownerSession();
    const a = await action(null);
    for (const ownerId of [outsider, NO_SUCH_USER, leaver, dormant]) {
      const res = await editAction(json("PATCH", { ownerId }), at(a.id));
      expect(res.status, ownerId).toBe(400);
    }
    expect((await prisma.retroActionItem.findUniqueOrThrow({ where: { id: a.id } })).ownerId).toBeNull();
    expect((await editAction(json("PATCH", { ownerId: colleague }), at(a.id))).status).toBe(200);
  });

  it("promoting an action whose owner isn't in the org files the work unassigned", async () => {
    h.ctx = ownerSession();
    const a = await action(outsider); // as rows written before the PATCH check would be
    const res = await promoteAction(new NextRequest("http://localhost/x", { method: "POST" }), at(a.id));
    expect(res.status).toBeLessThan(300);
    const { workItemId } = await prisma.retroActionItem.findUniqueOrThrow({ where: { id: a.id } });
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: workItemId! } })).assigneeId).toBeNull();
  });

  it("an owner who has since left, or been deactivated, isn't made the assignee either", async () => {
    h.ctx = ownerSession();
    for (const ownerId of [leaver, dormant]) {
      const a = await action(ownerId);
      expect((await promoteAction(new NextRequest("http://localhost/x", { method: "POST" }), at(a.id))).status, ownerId).toBeLessThan(300);
      const { workItemId } = await prisma.retroActionItem.findUniqueOrThrow({ where: { id: a.id } });
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: workItemId! } })).assigneeId, ownerId).toBeNull();
    }
  });

  it("an owner in the org is still the assignee", async () => {
    h.ctx = ownerSession();
    const a = await action(colleague);
    await promoteAction(new NextRequest("http://localhost/x", { method: "POST" }), at(a.id));
    const { workItemId } = await prisma.retroActionItem.findUniqueOrThrow({ where: { id: a.id } });
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: workItemId! } })).assigneeId).toBe(colleague);
  });
});

