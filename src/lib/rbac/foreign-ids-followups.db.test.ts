// @vitest-environment node
//
// More of foreign-ids.db.test.ts's rule, for paths a review found after it:
//
//   - completing a sprint moves its unfinished items into a sprint the body
//     names, which must be one of this project's;
//   - reads that list a sprint's items or an item's children show only the
//     org's own rows, even where an older write left another org's row
//     pointing here;
//   - the assistant's create_meeting holds a sprint to the meeting's project,
//     as the REST route does;
//   - deleting a work-item type counts only the org's own items as using it;
//   - the work-item create backstop, and the viewer bound on a time entry's
//     item and a classification's project, each tested on its own.
//
// Each refusal has a positive control.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { ProblemError } from "@/lib/openapi/problem";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { allocateTicketNumber } from "@/lib/work-items/allocate";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("@/lib/cache/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/queries")>()),
  revalidateOrgProjects: vi.fn(),
}));

import { POST as completeInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/complete/route";
import { GET as getInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/route";
import { POST as mergeItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/merge/route";
import { POST as createTimeEntry } from "@/app/api/v1/orgs/[orgId]/time-entries/route";
import { POST as classify } from "@/app/api/v1/orgs/[orgId]/classifications/route";
import { createMeeting as createMeetingTool } from "@/lib/ai/executors/meetings";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { DELETE as deleteType } from "@/app/api/v1/orgs/[orgId]/work-item-types/[typeId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
const K = stamp.slice(0, 3).toUpperCase();

// Org A is the caller's; org B is somebody else's. `hidden` is a team-scoped
// project of org A that `member` is not on; p1 and p2 are open.
let orgA = "", orgB = "", owner = "", ownerB = "", member = "";
let p1 = "", p2 = "", hidden = "", pB = "", typeId = "";
let sprintN = 0;

const ownerSession = (): AuthContext => ({
  userId: owner, orgId: orgA, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [],
});
/** Every permission bit, but a MEMBER: team-scoped projects stay hidden. */
const memberSession = (): AuthContext => ({
  userId: member, orgId: orgA, orgRole: "MEMBER", permissions: -1n, basePermissions: -1n, abacRules: [],
});
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const tag = () => `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
const item = (orgId: string, projectId: string, title = tag(), createdById = orgId === orgA ? owner : ownerB) =>
  createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById, title, columnKey: "todo" });
const sprint = (orgId: string, projectId: string, status: "ACTIVE" | "PLANNED" = "PLANNED") =>
  prisma.interval.create({
    data: { orgId, projectId, number: ++sprintN, name: tag(), status, startDate: new Date("2026-11-02"), endDate: new Date("2026-11-13") },
  });
/** What an older, unchecked write could leave behind: another org's item pointing at ours. */
const plantInterval = (itemId: string, intervalId: string) =>
  prisma.$executeRaw`UPDATE work_items SET interval_id = ${intervalId}::uuid WHERE id = ${itemId}::uuid`;
const plantParent = (itemId: string, parentId: string) =>
  prisma.$executeRaw`UPDATE work_items SET parent_id = ${parentId}::uuid WHERE id = ${itemId}::uuid`;

beforeAll(async () => {
  const user = async (n: string) => (await prisma.user.create({ data: { email: `${n}-${stamp}@fu.test`, displayName: n } })).id;
  [owner, ownerB, member] = [await user("owner"), await user("ownerb"), await user("member")];
  orgA = (await prisma.organization.create({ data: { name: `fu a ${stamp}`, slug: `fu-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `fu b ${stamp}`, slug: `fu-b-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId: orgA, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgA, userId: member, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgB, userId: ownerB, role: "OWNER", permissions: "0" } });
  p1 = (await prisma.project.create({ data: { orgId: orgA, name: "P1", key: `FA${K}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId: orgA, name: "P2", key: `FB${K}` } })).id;
  hidden = (await prisma.project.create({ data: { orgId: orgA, name: "Hidden", key: `FC${K}`, teamScopedAccess: true } })).id;
  pB = (await prisma.project.create({ data: { orgId: orgB, name: "PB", key: `FD${K}` } })).id;
  for (const p of [p1, p2, hidden, pB]) await ensureFixtureStatuses(p);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, ownerB, member] } } }).catch(() => undefined);
});

describe("completing a sprint moves unfinished items only into this project's sprints", () => {
  const complete = (projectId: string, intervalId: string, moveTo: string) =>
    completeInterval(json("POST", { moveIncompleteToIntervalId: moveTo }), {
      params: Promise.resolve({ orgId: orgA, projectId, intervalId }),
    });

  it.each([
    ["another org's sprint", () => sprint(orgB, pB)],
    ["another project's sprint", () => sprint(orgA, p2)],
  ])("refuses %s, and the sprint and its items are unchanged", async (_why, target) => {
    h.ctx = ownerSession();
    const active = await sprint(orgA, p1, "ACTIVE");
    const open = await item(orgA, p1);
    await plantInterval(open.id, active.id);
    const to = await target();
    expect((await complete(p1, active.id, to.id)).status).toBe(400);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: open.id } })).intervalId).toBe(active.id);
    expect((await prisma.interval.findUniqueOrThrow({ where: { id: active.id } })).status).toBe("ACTIVE");
  });

  it("moves them into a sprint of this project", async () => {
    h.ctx = ownerSession();
    const [active, next] = [await sprint(orgA, p1, "ACTIVE"), await sprint(orgA, p1)];
    const open = await item(orgA, p1);
    await plantInterval(open.id, active.id);
    expect((await complete(p1, active.id, next.id)).status).toBe(200);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: open.id } })).intervalId).toBe(next.id);
  });

  it("leaves another org's item that points at the sprint where it was", async () => {
    h.ctx = ownerSession();
    const [active, next] = [await sprint(orgA, p1, "ACTIVE"), await sprint(orgA, p1)];
    const theirs = await item(orgB, pB);
    await plantInterval(theirs.id, active.id);
    expect((await complete(p1, active.id, next.id)).status).toBe(200);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: theirs.id } })).intervalId).toBe(active.id);
  });
});

describe("reads list only the org's own items", () => {
  it("a sprint's items leave out another org's item that points at it", async () => {
    h.ctx = ownerSession();
    const s = await sprint(orgA, p1);
    const [mine, theirs] = [await item(orgA, p1, `mine-${tag()}`), await item(orgB, pB, `theirs-${tag()}`)];
    await plantInterval(mine.id, s.id);
    await plantInterval(theirs.id, s.id);
    const res = await getInterval(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ orgId: orgA, projectId: p1, intervalId: s.id }),
    });
    const body = JSON.stringify(await res.json());
    expect(body).toContain(mine.title);
    expect(body).not.toContain(theirs.title);
  });

  it("a merge's response leaves out another org's child of the surviving item", async () => {
    h.ctx = ownerSession();
    const [dup, into] = [await item(orgA, p1), await item(orgA, p1)];
    const [mine, theirs] = [await item(orgA, p1, `child-${tag()}`), await item(orgB, pB, `secret-${tag()}`)];
    await plantParent(mine.id, into.id);
    await plantParent(theirs.id, into.id);
    const res = await mergeItem(json("POST", { intoId: into.id }), {
      params: Promise.resolve({ orgId: orgA, projectId: p1, itemId: dup.id }),
    });
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain(mine.title);
    expect(body).not.toContain(theirs.title);
  });
});

describe("the assistant's create_meeting holds a sprint to the meeting's project", () => {
  const tool = (auth: AuthContext) => ({ orgId: orgA, userId: auth.userId, auth });

  it("refuses another project's sprint when the meeting names a project", async () => {
    const title = tag();
    const other = await sprint(orgA, p2);
    const out = (await createMeetingTool({ title, meetingDate: "2026-11-20T15:00:00.000Z", projectId: p1, sprintId: other.id }, tool(ownerSession()))) as { error?: string };
    expect(out.error).toBeTruthy();
    expect(await prisma.syncMeeting.count({ where: { orgId: orgA, title } })).toBe(0);
  });

  it("refuses a sprint in a project the caller can't see when no project is named", async () => {
    const title = tag();
    const unseen = await sprint(orgA, hidden);
    const out = (await createMeetingTool({ title, meetingDate: "2026-11-20T15:00:00.000Z", sprintId: unseen.id }, tool(memberSession()))) as { error?: string };
    expect(out.error).toBeTruthy();
    expect(await prisma.syncMeeting.count({ where: { orgId: orgA, title } })).toBe(0);
  });

  it("accepts a sprint of the meeting's project", async () => {
    const s = await sprint(orgA, p1);
    const out = (await createMeetingTool({ title: tag(), meetingDate: "2026-11-20T15:00:00.000Z", projectId: p1, sprintId: s.id }, tool(ownerSession()))) as { error?: string };
    expect(out.error).toBeUndefined();
  });
});

describe("the work-item create backstop, on its own", () => {
  // No route in front of it: the check inside createWorkItemRow is the only one.
  const create = (parentId: string, title: string) =>
    prisma.$transaction(async (tx) =>
      createWorkItemRow(
        tx,
        {
          data: {
            orgId: orgA, projectId: p1, workItemTypeId: typeId, createdById: owner, title, description: "",
            columnKey: "todo", parentId, ticketNumber: await allocateTicketNumber(tx, { orgId: orgA, projectId: p1 }),
          },
        },
        { actorId: owner, source: "SYSTEM" },
      ),
    );

  it("refuses another org's parent, and the create rolls back", async () => {
    const theirs = await item(orgB, pB);
    const title = tag();
    const err = await create(theirs.id, title).catch((e) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err.status).toBe(400);
    expect(await prisma.workItem.count({ where: { orgId: orgA, title } })).toBe(0);
  });

  it("creates under a parent of the same project", async () => {
    const parent = await item(orgA, p1);
    const created = await create(parent.id, tag());
    expect(created.parentId).toBe(parent.id);
  });
});

describe("with no project named, the viewer bounds what a write may point at", () => {
  it("a time entry can't name an item in a project the caller can't see", async () => {
    h.ctx = memberSession();
    const unseen = await item(orgA, hidden);
    const description = tag();
    const res = await createTimeEntry(json("POST", { date: "2026-11-12", hours: 1, description, workItemId: unseen.id }), { params: Promise.resolve({ orgId: orgA }) });
    expect(res.status).toBe(400);
    expect(await prisma.timeEntry.count({ where: { orgId: orgA, description } })).toBe(0);
    // Positive control: an item in a project the caller can see.
    const seen = await item(orgA, p1);
    const ok = await createTimeEntry(json("POST", { date: "2026-11-12", hours: 1, description: tag(), workItemId: seen.id }), { params: Promise.resolve({ orgId: orgA }) });
    expect(ok.status).toBeLessThan(300);
  });

  it("a classification can't name a project the caller can't see", async () => {
    h.ctx = memberSession();
    const res = await classify(json("POST", { projectId: hidden, level: "CUI" }), { params: Promise.resolve({ orgId: orgA }) });
    expect(res.status).toBe(400);
    expect(await prisma.dataClassification.count({ where: { projectId: hidden } })).toBe(0);
    // Positive control: a project the caller can see.
    const ok = await classify(json("POST", { projectId: p2, level: "CUI" }), { params: Promise.resolve({ orgId: orgA }) });
    expect(ok.status).toBeLessThan(300);
  });
});

describe("deleting a work-item type counts only the org's own items", () => {
  const customType = async () =>
    (await prisma.workItemType.create({ data: { orgId: orgA, key: `t-${tag()}`, name: tag() } })).id;
  const del = (id: string) => deleteType(json("DELETE"), { params: Promise.resolve({ orgId: orgA, typeId: id }) });
  const plantType = (itemId: string, id: string) =>
    prisma.$executeRaw`UPDATE work_items SET work_item_type_id = ${id}::uuid WHERE id = ${itemId}::uuid`;

  it("another org's item pointing at it is not counted, and the type is still kept", async () => {
    h.ctx = ownerSession();
    const t = await customType();
    await plantType((await item(orgB, pB)).id, t);
    const res = await del(t);
    expect(res.status).toBe(409);
    expect((await res.json()).count).toBe(0);
    expect(await prisma.workItemType.count({ where: { id: t } })).toBe(1);
  });

  it("the org's own items are counted, and an unused type is deleted", async () => {
    h.ctx = ownerSession();
    const used = await customType();
    await plantType((await item(orgA, p1)).id, used);
    const res = await del(used);
    expect(res.status).toBe(409);
    expect((await res.json()).count).toBe(1);
    const unused = await customType();
    expect((await del(unused)).status).toBeLessThan(300);
    expect(await prisma.workItemType.count({ where: { id: unused } })).toBe(0);
  });
});
