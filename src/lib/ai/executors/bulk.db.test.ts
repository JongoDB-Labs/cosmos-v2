// @vitest-environment node
//
// bulk_update_work_items against the bulk route, for the SAME real actor, in a
// real database (e2e DB). The tool's gate is the route's, project by project:
// the project is visible and the caller holds ITEM_BULK_EDIT or manages it. On
// top of that each ROW passes the single-item edit gate, and a row that fails
// any of it is skipped and reported while the rest still change.
//
// Own org and own users; the seeded ones are never touched. Every skip or
// refusal has a control beside it showing the same change landing where it
// should.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import type { OrgRole } from "@prisma/client";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import type { ToolContext } from "./_ctx";
import { bulkUpdateWorkItems } from "./bulk";
import { BULK_TOOL_MAX } from "../tools/bulk";
import { PUT as bulkRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";

type Skip = { id: string; ticketKey?: string; reason: string };
type Out = { error?: string; matched?: number; updated?: number; items?: { id: string; ticketKey: string }[]; skipped?: Skip[] };
const bulk = async (input: Record<string, unknown>, ctx: ToolContext) => (await bulkUpdateWorkItems(input, ctx)) as Out;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const k = stamp.slice(-4).toUpperCase();
const userIds: string[] = [];
let orgId = "", typeId = "", ownerId = "", memberId = "";
/** `managed`: the manager MANAGES it. `plain`: the manager is only a member. `hidden`: team-scoped, the manager is not on it. */
let managed = "", plain = "", hidden = "", big = "";
let sprint = "", otherSprint = "";
let owner: ToolContext, manager: ToolContext, member: ToolContext, restricted: ToolContext, blind: ToolContext;

async function user(name: string) {
  const u = await prisma.user.create({ data: { email: `${name}-${stamp}@example.com`, displayName: name } });
  userIds.push(u.id);
  return u.id;
}

const item = async (projectId: string, title: string, createdById = memberId) =>
  (await createFixtureWorkItem({ orgId, projectId, workItemTypeId: typeId, createdById, title, columnKey: "todo" })).id;
const rowsOf = (ids: string[]) =>
  prisma.workItem.findMany({ where: { id: { in: ids } }, select: { id: true, intervalId: true, columnKey: true, priority: true, tags: true, assigneeId: true } });

async function asRest(actor: ToolContext, projectId: string, body: unknown) {
  getAuthContext.mockResolvedValue(actor.auth);
  const res = await bulkRoute(
    new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ orgId, projectId }) } as never,
  );
  return res.status;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `bulk ${stamp}`, slug: `bulk-${stamp}` } })).id;
  const om = async (userId: string, role: OrgRole, abacRules?: object) =>
    (await prisma.orgMember.create({ data: { orgId, userId, role, ...(abacRules ? { abacRules } : {}) } })).id;

  ownerId = await user("owner");
  const managerId = await user("manager");
  memberId = await user("member");
  const restrictedId = await user("restricted");
  await om(ownerId, "OWNER");
  const managerOm = await om(managerId, "MEMBER");
  const memberOm = await om(memberId, "MEMBER");
  // A deny policy: may not edit what the owner filed. One at a time it stops
  // them in the app; the bulk tool must stop them too.
  const restrictedOm = await om(restrictedId, "MEMBER", [
    { effect: "deny", actions: ["ITEM_UPDATE"], conditions: [{ attr: "createdById", op: "eq", value: ownerId }] },
  ]);

  // May not even READ what the owner filed: a row it cannot read must read as
  // not found, never be changed, and never have its key echoed.
  const blindId = await user("blind");
  const blindOm = await om(blindId, "MEMBER", [
    { effect: "deny", actions: ["ITEM_READ"], conditions: [{ attr: "createdById", op: "eq", value: ownerId }] },
  ]);

  managed = (await prisma.project.create({ data: { orgId, name: "Managed", key: `BKA${k}` } })).id;
  plain = (await prisma.project.create({ data: { orgId, name: "Plain", key: `BKB${k}` } })).id;
  hidden = (await prisma.project.create({ data: { orgId, name: "Hidden", key: `BKC${k}`, teamScopedAccess: true } })).id;
  big = (await prisma.project.create({ data: { orgId, name: "Big", key: `BKD${k}` } })).id;
  for (const [projectId, om2, role] of [
    [managed, managerOm, "MANAGER"], [managed, memberOm, "MEMBER"], [managed, restrictedOm, "MANAGER"],
    [plain, managerOm, "MEMBER"], [big, managerOm, "MANAGER"],
    [managed, blindOm, "MANAGER"], [plain, blindOm, "MEMBER"],
  ] as const) {
    await prisma.projectMember.create({ data: { projectId, orgMemberId: om2, role } });
  }

  typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  for (const p of [managed, plain, hidden, big]) await ensureFixtureStatuses(p, ["todo", "doing", "done"], { doing: "IN_PROGRESS", done: "DONE" });

  const iv = (projectId: string, number: number) =>
    prisma.interval.create({
      data: { orgId, projectId, number, name: `Sprint ${number}`, startDate: new Date("2026-01-05"), endDate: new Date("2026-01-16") },
    });
  sprint = (await iv(managed, 1)).id;
  otherSprint = (await iv(plain, 1)).id;

  owner = await memberToolCtx(orgId, ownerId);
  manager = await memberToolCtx(orgId, managerId);
  member = await memberToolCtx(orgId, memberId);
  restricted = await memberToolCtx(orgId, restrictedId);
  blind = await memberToolCtx(orgId, blindId);
}, 120_000);

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("bulk_update_work_items holds the bulk route's gate", () => {
  it("the fixture is what it claims", () => {
    const has = (c: ToolContext, bit: bigint) => (c.auth!.permissions & bit) === bit;
    expect(has(member, Permission.ITEM_BULK_EDIT)).toBe(false);
    expect(has(manager, Permission.ITEM_BULK_EDIT)).toBe(false);
    expect(has(owner, Permission.ITEM_BULK_EDIT)).toBe(true);
    expect(restricted.auth!.abacRules.length).toBe(1);
  });

  it("the project's manager moves three items into a sprint", async () => {
    const ids = [await item(managed, "one"), await item(managed, "two"), await item(managed, "three")];
    const out = await bulk({ ids, intervalId: sprint }, manager);
    expect(out).toMatchObject({ matched: 3, updated: 3, skipped: [] });
    expect((await rowsOf(ids)).map((r) => r.intervalId)).toEqual([sprint, sprint, sprint]);

    // "none" takes them out again.
    expect(await bulk({ ids, intervalId: "none" }, manager)).toMatchObject({ updated: 3 });
    expect((await rowsOf(ids)).every((r) => r.intervalId === null)).toBe(true);
  });

  it("a member without bulk-edit is refused through both doors, and nothing moves", async () => {
    const ids = [await item(managed, "m1"), await item(managed, "m2")];
    expect(await asRest(member, managed, { ids, update: { intervalId: sprint } })).toBe(403);
    const out = await bulk({ ids, intervalId: sprint }, member);
    expect(out.updated).toBe(0);
    expect(out.skipped!.map((s) => s.reason)).toEqual([
      expect.stringMatching(/bulk-edit permission or the project's manager role/),
      expect.stringMatching(/bulk-edit permission or the project's manager role/),
    ]);
    expect((await rowsOf(ids)).every((r) => r.intervalId === null)).toBe(true);

    // Control: the manager's same change lands, through the route and the tool.
    expect(await asRest(manager, managed, { ids: [ids[0]], update: { intervalId: sprint } })).toBe(200);
    expect((await bulk({ ids: [ids[1]], intervalId: sprint }, manager)).updated).toBe(1);
    expect((await rowsOf(ids)).every((r) => r.intervalId === sprint)).toBe(true);
  });

  it("a mixed selection changes only where the caller may, and says why for the rest", async () => {
    const mine = await item(managed, "mine");
    const notManaged = await item(plain, "not managed");
    const unseen = await item(hidden, "unseen");
    const out = await bulk({ ids: [mine, notManaged, unseen], priority: "HIGH" }, manager);

    expect(out.items!.map((i) => i.id)).toEqual([mine]);
    const why = new Map(out.skipped!.map((s) => [s.id, s]));
    expect(why.get(notManaged)!.reason).toMatch(/bulk-edit permission/);
    expect(why.get(notManaged)!.ticketKey).toMatch(new RegExp(`^BKB${k}-`));
    // A project the caller cannot open: not found, and its ticket key is not echoed.
    expect(why.get(unseen)).toEqual({ id: unseen, reason: "Work item not found" });

    const rows = new Map((await rowsOf([mine, notManaged, unseen])).map((r) => [r.id, r.priority]));
    expect(rows.get(mine)).toBe("HIGH");
    expect(rows.get(notManaged)).not.toBe("HIGH");
    expect(rows.get(unseen)).not.toBe("HIGH");

    // Control: the owner, who holds bulk-edit and sees everything, changes all three.
    expect((await bulk({ ids: [mine, notManaged, unseen], priority: "HIGH" }, owner)).updated).toBe(3);
  });

  it("each row passes the single-item edit gate: a deny policy skips the rows it covers", async () => {
    const theirs = await item(managed, "filed by the owner", ownerId);
    const ok = await item(managed, "filed by a member");
    const out = await bulk({ ids: [theirs, ok], status: "doing" }, restricted);
    expect(out.items!.map((i) => i.id)).toEqual([ok]);
    expect(out.skipped).toEqual([{ id: theirs, ticketKey: expect.stringMatching(new RegExp(`^BKA${k}-`)), reason: "You may not edit this item" }]);
    const rows = new Map((await rowsOf([theirs, ok])).map((r) => [r.id, r.columnKey]));
    expect(rows.get(theirs)).toBe("todo");
    expect(rows.get(ok)).toBe("doing");
  });

  it("a row the caller may not read is not found, is not changed, and its key is never echoed", async () => {
    const keyOf = async (id: string) => {
      const r = await prisma.workItem.findUniqueOrThrow({ where: { id }, select: { ticketNumber: true, project: { select: { key: true } } } });
      return `${r.project.key}-${r.ticketNumber}`;
    };
    // Its read rule names a row attribute, so it fails closed at the project, as
    // get_work_item does: no item here is readable to it, even one it manages.
    const unseen = await item(managed, "filed by the owner", ownerId);
    const seen = await item(managed, "filed by a member");
    const out = await bulk({ ids: [unseen, seen], priority: "LOW" }, blind);
    expect(out.updated).toBe(0);
    expect(out.skipped).toEqual([
      { id: unseen, reason: "Work item not found" },
      { id: seen, reason: "Work item not found" },
    ]);
    const echoed = JSON.stringify(out);
    for (const id of [unseen, seen]) expect(echoed).not.toContain(await keyOf(id));
    expect((await rowsOf([unseen, seen])).map((r) => r.priority)).not.toContain("LOW");

    // Where it is a plain member and may not bulk-edit either, still nothing is named.
    const plainRow = await item(plain, "filed by a member");
    const out2 = await bulk({ ids: [plainRow], priority: "LOW" }, blind);
    expect(out2.skipped).toEqual([{ id: plainRow, reason: "Work item not found" }]);

    // Positive control: a caller who CAN read a row it may not bulk-edit is told which.
    const out3 = await bulk({ ids: [seen], priority: "LOW" }, member);
    expect(out3.skipped).toEqual([{ id: seen, ticketKey: await keyOf(seen), reason: expect.stringMatching(/bulk-edit permission/) }]);
  });

  it("a key scoped to another project changes nothing here", async () => {
    const ids = [await item(managed, "scoped")];
    const key: ToolContext = { ...manager, auth: { ...manager.auth!, projectScope: [plain] } };
    expect(await bulk({ ids, priority: "LOW" }, key)).toMatchObject({ updated: 0, skipped: [{ id: ids[0], reason: "Work item not found" }] });
    // Control: scoped to this project, the same manager changes it.
    const inScope: ToolContext = { ...manager, auth: { ...manager.auth!, projectScope: [managed] } };
    expect((await bulk({ ids, priority: "LOW" }, inScope)).updated).toBe(1);
  });

  it("a sprint from another project, or a status the project lacks, skips with the reason", async () => {
    const ids = [await item(managed, "x")];
    expect((await bulk({ ids, intervalId: otherSprint }, manager)).skipped![0].reason).toMatch(/sprint is not in this item's project/);
    expect((await bulk({ ids, status: "Nonexistent" }, manager)).skipped![0].reason).toMatch(/no status "Nonexistent"/);
    expect((await rowsOf(ids))[0]).toMatchObject({ intervalId: null, columnKey: "todo" });
    // Control: the status by its NAME, case-insensitively, lands.
    expect((await bulk({ ids, status: "DOING" }, manager)).updated).toBe(1);
  });

  it("labels are added and removed per item, keeping each item's others", async () => {
    const a = await item(managed, "labels a");
    const b = await item(managed, "labels b");
    await prisma.workItem.update({ where: { id: a }, data: { tags: ["keep", "old"] } });
    await prisma.workItem.update({ where: { id: b }, data: { tags: ["other"] } });
    expect((await bulk({ ids: [a, b], addLabels: ["new"], removeLabels: ["old"] }, manager)).updated).toBe(2);
    const tags = new Map((await rowsOf([a, b])).map((r) => [r.id, [...r.tags].sort()]));
    expect(tags.get(a)).toEqual(["keep", "new"]);
    expect(tags.get(b)).toEqual(["new", "other"]);
  });

  it("by query: changes what the query matches, as the caller", async () => {
    const hits = [await item(big, "query hit 1"), await item(big, "query hit 2")];
    await prisma.workItem.updateMany({ where: { id: { in: hits } }, data: { priority: "CRITICAL" } });
    const out = await bulk({ cql: `project = BKD${k} AND priority = Critical`, assigneeId: "me" }, manager);
    expect(out).toMatchObject({ matched: 2, updated: 2 });
    expect((await rowsOf(hits)).every((r) => r.assigneeId === manager.userId)).toBe(true);
  });

  it(`refuses a query that matches more than ${BULK_TOOL_MAX} items, whole, and changes none`, async () => {
    const start = await prisma.workItem.count({ where: { projectId: big } });
    await prisma.workItem.createMany({
      data: Array.from({ length: BULK_TOOL_MAX + 1 }, (_, i) => ({
        orgId, projectId: big, workItemTypeId: typeId, createdById: memberId, title: `many ${i}`, description: "",
        columnKey: "todo", ticketNumber: 1000 + i,
      })),
    });
    const out = await bulk({ cql: `project = BKD${k} AND title ~ "many"`, priority: "LOW" }, manager);
    expect(out.error).toMatch(new RegExp(`matches ${BULK_TOOL_MAX + 1} items`));
    expect(await prisma.workItem.count({ where: { projectId: big, priority: "LOW" } })).toBe(0);
    expect(await prisma.workItem.count({ where: { projectId: big } })).toBe(start + BULK_TOOL_MAX + 1);

    // Control: a query that matches fewer is applied.
    expect((await bulk({ cql: `project = BKD${k} AND title ~ "many 10"`, priority: "LOW" }, manager)).updated).toBeGreaterThan(0);
  });

  it("an id list longer than the cap is refused before anything runs", async () => {
    const ids = Array.from({ length: BULK_TOOL_MAX + 1 }, () => crypto.randomUUID());
    expect((await bulk({ ids, priority: "LOW" }, owner)).error).toMatch(/Invalid input/);
  });
});
