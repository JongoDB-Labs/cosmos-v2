// @vitest-environment node
//
// Creating a work item asks ITEM_CREATE about every person the item will be
// assigned to, so a rule over the assignee ("this member may not create work
// for X") holds whichever field names them and wherever they sit in the list.
// One row per assignee, each with the same creator and project; an unassigned
// item is one row with no assignee.
//
// The paths covered here are the ones that create an item for named people:
// the create route, Duplicate (and the sub-items it copies), Split, the
// assistant's create_work_item, and promoting a retro action. Not covered: CSV
// import, item ingest, document conversion and feedback remediation, which
// write no assignee and ask ITEM_CREATE (or nothing) without one.
//
// The permission itself is asked whatever the assignees are: someone without
// ITEM_CREATE is refused an unassigned item too.
//
// Against a real database: the rules are stored on the member
// (org_members.abac_rules) and read back by the loader a request uses, so the
// engine evaluates what an org would author. Own org and users throughout; the
// seeded users are shared by every DB spec.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { memberToolCtx } from "@/lib/testing/tool-auth";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { POST as createItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { POST as duplicateItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/duplicate/route";
import { POST as splitItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/split-assignees/route";
import { POST as promoteAction } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/actions/[actionId]/promote/route";
import { createWorkItem as aiCreateWorkItem } from "@/lib/ai/executors/work-items";

const stamp = Math.random().toString(36).slice(2, 8);
let orgId = "", projectId = "", typeId = "";
let owner = "", maker = "", picky = "", allowed = "", barred = "", third = "", viewer = "";
const users: string[] = [];

beforeAll(async () => {
  const mk = async (n: string) => {
    const u = await prisma.user.create({ data: { email: `${n}-${stamp}@create-policy.test`, displayName: n } });
    users.push(u.id);
    return u.id;
  };
  [owner, maker, picky, allowed, barred, third, viewer] = await Promise.all(
    ["owner", "maker", "picky", "allowed", "barred", "third", "viewer"].map(mk),
  );
  orgId = (await prisma.organization.create({ data: { name: `cp ${stamp}`, slug: `cp-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: owner, role: "OWNER", permissions: "0" } });
  // May create work for anyone but `barred`.
  await prisma.orgMember.create({
    data: {
      orgId, userId: maker, role: "MEMBER", permissions: "0",
      abacRules: { rules: [{ effect: "deny", actions: ["ITEM_CREATE"], conditions: [{ attr: "assigneeId", op: "eq", value: barred }] }] },
    },
  });
  // May create work only for `allowed`: not for anyone else, and not unassigned.
  await prisma.orgMember.create({
    data: {
      orgId, userId: picky, role: "MEMBER", permissions: "0",
      abacRules: { rules: [{ effect: "deny", actions: ["ITEM_CREATE"], conditions: [{ attr: "assigneeId", op: "nin", value: [allowed] }] }] },
    },
  });
  for (const userId of [allowed, barred, third]) {
    await prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER", permissions: "0" } });
  }
  // Can open the project and read its items, but holds no ITEM_CREATE.
  await prisma.orgMember.create({ data: { orgId, userId: viewer, role: "VIEWER", permissions: "0" } });
  projectId = (await prisma.project.create({ data: { orgId, name: "Open", key: `CP${stamp.slice(0, 3).toUpperCase()}` } })).id;
  await ensureFixtureStatuses(projectId);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

/** Act as `userId`, with the access a request of theirs would load, rules included. */
async function as(userId: string) {
  h.ctx = await loadMemberAuthContext(orgId, userId);
  expect(h.ctx).not.toBeNull();
}
const post = (body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method: "POST",
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const onItem = (itemId: string) => ({ params: Promise.resolve({ orgId, projectId, itemId }) });
const titled = (title: string) => prisma.workItem.count({ where: { orgId, title } });
const assigneesOf = async (workItemId: string) =>
  (await prisma.workItemAssignee.findMany({ where: { workItemId }, orderBy: { sortOrder: "asc" }, select: { userId: true } })).map(
    (a) => a.userId,
  );

/** POST /work-items with this body, under a title of its own; the response and the title. */
async function create(body: Record<string, unknown>) {
  const title = `create ${Math.random().toString(36).slice(2, 10)}`;
  const res = await createItem(post({ title, columnKey: "todo", workItemTypeId: typeId, ...body }), {
    params: Promise.resolve({ orgId, projectId }),
  });
  return { res, title };
}

/** An item the owner made, assigned to `ids` in order (the first is the primary). */
async function itemFor(ids: string[], extra: { parentId?: string } = {}) {
  const title = `src ${Math.random().toString(36).slice(2, 10)}`;
  const item = await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById: owner, title, columnKey: "todo" });
  await prisma.workItem.update({
    where: { id: item.id },
    data: {
      assigneeId: ids[0] ?? null,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
      assignees: { create: ids.map((userId, sortOrder) => ({ userId, sortOrder })) },
    },
  });
  return { id: item.id, title };
}

describe("the create route asks about every assignee", () => {
  it("control: an item for people the rule allows is created, carrying exactly them", async () => {
    await as(maker);
    const { res } = await create({ assigneeIds: [allowed, third] });
    expect(res.status).toBe(201);
    expect(await assigneesOf((await res.json()).id)).toEqual([allowed, third]);
  });

  it("single only: an assigneeId the rule bars is refused, and nothing is written", async () => {
    await as(maker);
    const { res, title } = await create({ assigneeId: barred });
    expect(res.status).toBe(403);
    expect(await titled(title)).toBe(0);
  });

  it("list only: an assigneeIds list naming someone the rule bars is refused, first or not", async () => {
    await as(maker);
    for (const assigneeIds of [[barred], [allowed, barred], [third, allowed, barred]]) {
      const { res, title } = await create({ assigneeIds });
      expect(res.status, JSON.stringify(assigneeIds)).toBe(403);
      expect(await titled(title)).toBe(0);
    }
  });

  it("both: the list is what the item gets, so the list is what is checked", async () => {
    await as(maker);
    const hidden = await create({ assigneeId: allowed, assigneeIds: [barred] });
    expect(hidden.res.status).toBe(403);
    expect(await titled(hidden.title)).toBe(0);
    // The single field is ignored when a list is sent, so it isn't held against the caller either.
    const ignored = await create({ assigneeId: barred, assigneeIds: [allowed] });
    expect(ignored.res.status).toBe(201);
    expect(await assigneesOf((await ignored.res.json()).id)).toEqual([allowed]);
  });

  it("an empty list: the item is unassigned, and an unassigned item is what is checked", async () => {
    await as(picky);
    // Control: the one person this member may create work for.
    expect((await create({ assigneeIds: [allowed] })).res.status).toBe(201);
    // An empty list wins over the single field, so this item would be unassigned.
    const unassigned = await create({ assigneeId: allowed, assigneeIds: [] });
    expect(unassigned.res.status).toBe(403);
    expect(await titled(unassigned.title)).toBe(0);

    await as(maker);
    const cleared = await create({ assigneeId: barred, assigneeIds: [] });
    expect(cleared.res.status).toBe(201);
    expect(await assigneesOf((await cleared.res.json()).id)).toEqual([]);
  });
});

describe("creating needs ITEM_CREATE, whoever the item is for", () => {
  // The rows asked about vary with the assignees, and an empty row list asks
  // nothing. The permission must not ride on there being a row: these items
  // are for nobody, and the caller has no ITEM_CREATE.
  it("an unassigned create is refused without ITEM_CREATE, and nothing is written", async () => {
    await as(viewer);
    for (const body of [{}, { assigneeIds: [] }]) {
      const { res, title } = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(await titled(title)).toBe(0);
    }
    // Control: the same request from a member who holds it.
    await as(maker);
    expect((await create({})).res.status).toBe(201);
  });

  it("an unassigned Duplicate is refused without ITEM_CREATE, and nothing is copied", async () => {
    const src = await itemFor([]);
    await as(viewer);
    expect((await duplicateItem(post(), onItem(src.id))).status).toBe(403);
    expect(await titled(`Copy of ${src.title}`)).toBe(0);
    // Control: the same copy by a member who holds it.
    await as(maker);
    expect((await duplicateItem(post(), onItem(src.id))).status).toBe(201);
    expect(await titled(`Copy of ${src.title}`)).toBe(1);
  });
});

describe("Duplicate asks about every assignee the copy carries", () => {
  it("control: a copy of an item for people the rule allows is made with all of them", async () => {
    await as(maker);
    const src = await itemFor([allowed, third]);
    const res = await duplicateItem(post(), onItem(src.id));
    expect(res.status).toBe(201);
    expect(await assigneesOf((await res.json()).id)).toEqual([allowed, third]);
  });

  it("a copy of an item that is also assigned to someone the rule bars is refused", async () => {
    await as(maker);
    const src = await itemFor([allowed, barred]);
    expect((await duplicateItem(post(), onItem(src.id))).status).toBe(403);
    expect(await titled(`Copy of ${src.title}`)).toBe(0);
  });

  it("each copied sub-item is asked about all of its assignees too, and a refusal copies nothing", async () => {
    await as(maker);
    const parent = await itemFor([allowed]);
    const kid = await itemFor([third, barred], { parentId: parent.id });
    expect((await duplicateItem(post({ withChildren: true }), onItem(parent.id))).status).toBe(403);
    expect(await titled(`Copy of ${parent.title}`)).toBe(0);
    expect(await titled(kid.title)).toBe(1);
  });
});

describe("Split asks about the person each copy is for", () => {
  it("control: splitting an item shared with people the rule allows makes their copies", async () => {
    await as(maker);
    const src = await itemFor([allowed, third]);
    const res = await splitItem(post(), onItem(src.id));
    expect(res.status).toBe(201);
    const copies = await prisma.workItem.findMany({ where: { orgId, title: src.title, id: { not: src.id } }, select: { id: true } });
    expect(copies).toHaveLength(1);
    expect(await assigneesOf(copies[0].id)).toEqual([third]);
  });

  it("a copy for someone the rule bars is refused, and the original keeps everyone", async () => {
    await as(maker);
    const src = await itemFor([allowed, barred]);
    expect((await splitItem(post(), onItem(src.id))).status).toBe(403);
    expect(await titled(src.title)).toBe(1);
    expect(await assigneesOf(src.id)).toEqual([allowed, barred]);
  });
});

describe("the assistant's create_work_item asks what the create route asks", () => {
  const tool = (title: string, assigneeId?: string) => ({ projectId, title, workItemTypeId: typeId, ...(assigneeId ? { assigneeId } : {}) });

  it("control: an item for someone the rule allows, or for nobody, is created", async () => {
    const ctx = await memberToolCtx(orgId, maker);
    const forAllowed = (await aiCreateWorkItem(tool(`ai-a ${stamp}`, allowed), ctx)) as { created?: boolean; id?: string; error?: string };
    expect(forAllowed.error).toBeUndefined();
    expect(forAllowed.created).toBe(true);
    expect(await assigneesOf(forAllowed.id!)).toEqual([allowed]);
    const forNobody = (await aiCreateWorkItem(tool(`ai-n ${stamp}`), ctx)) as { created?: boolean; error?: string };
    expect(forNobody.error).toBeUndefined();
    expect(forNobody.created).toBe(true);
  });

  it("an item for someone the rule bars is refused, and nothing is written", async () => {
    const ctx = await memberToolCtx(orgId, maker);
    const res = (await aiCreateWorkItem(tool(`ai-b ${stamp}`, barred), ctx)) as { created?: boolean; error?: string };
    expect(res.created).toBeUndefined();
    // The rule's refusal, not a project lookup that refuses everything.
    expect(res.error).toBe("Access denied by policy");
    expect(await titled(`ai-b ${stamp}`)).toBe(0);
  });

  it("an unassigned item is checked as one, as the route checks it", async () => {
    const ctx = await memberToolCtx(orgId, picky);
    const res = (await aiCreateWorkItem(tool(`ai-p ${stamp}`), ctx)) as { created?: boolean; error?: string };
    expect(res.created).toBeUndefined();
    expect(res.error).toBe("Access denied by policy");
    expect(await titled(`ai-p ${stamp}`)).toBe(0);
    const ok = (await aiCreateWorkItem(tool(`ai-pa ${stamp}`, allowed), ctx)) as { created?: boolean; error?: string };
    expect(ok.error).toBeUndefined();
    expect(ok.created).toBe(true);
  });
});

describe("promoting a retro action asks about its owner, who becomes the assignee", () => {
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
  const action = (ownerId: string) => prisma.retroActionItem.create({ data: { ceremonyId, text: `act ${ownerId}`, ownerId } });
  const promote = (actionId: string) =>
    promoteAction(post(), { params: Promise.resolve({ orgId, projectId, intervalId, actionId }) });

  it("control: an action owned by someone the rule allows becomes their work", async () => {
    await as(maker);
    const a = await action(allowed);
    expect((await promote(a.id)).status).toBe(200);
    const { workItemId } = await prisma.retroActionItem.findUniqueOrThrow({ where: { id: a.id } });
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: workItemId! } })).assigneeId).toBe(allowed);
  });

  it("an action owned by someone the rule bars is refused, and no work is filed", async () => {
    await as(maker);
    const a = await action(barred);
    expect((await promote(a.id)).status).toBe(403);
    expect((await prisma.retroActionItem.findUniqueOrThrow({ where: { id: a.id } })).workItemId).toBeNull();
    expect(await titled(`act ${barred}`)).toBe(0);
  });
});
