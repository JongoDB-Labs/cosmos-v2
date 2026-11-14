// @vitest-environment node
//
// The last writes foreign-id-writes.arch.test.ts listed as known gaps, and the
// work-item writer's own backstop:
//
//   - a template widget's parent must be a widget of the same template;
//   - a preference's default board must be one the caller may open, and its
//     theme this org's or a built-in one;
//   - a sprint's capacity rows name current members of the org;
//   - updateWorkItems holds every row an update points at to the item's own
//     org and project, whichever caller built the data, without a query per row.
//
// Each refusal has a positive control.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { ProblemError } from "@/lib/openapi/problem";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import { RECORDED_BY_CALLER } from "@/lib/work-items/events.server";
import { updateWorkItems, updateWorkItemsUnchecked } from "@/lib/work-items/write.server";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));

import { PUT as syncWidgets } from "@/app/api/v1/orgs/[orgId]/templates/[templateId]/widgets/route";
import { PUT as putPreferences } from "@/app/api/v1/orgs/[orgId]/preferences/route";
import { PUT as putCapacity } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/capacity/route";

const stamp = Math.random().toString(36).slice(2, 8);
const K = stamp.slice(0, 3).toUpperCase();

// Org A is the caller's; org B is somebody else's. `hidden` is a team-scoped
// project of org A that `member` is not on; p1 and p2 are open.
let orgA = "", orgB = "", owner = "", ownerB = "", member = "", former = "";
let p1 = "", p2 = "", hidden = "", pB = "", typeId = "";
let n = 0;
const tag = () => `${stamp}-${++n}`;

const ownerSession = (): AuthContext => ({
  userId: owner, orgId: orgA, orgRole: "OWNER", permissions: -1n, basePermissions: -1n, abacRules: [],
});
/** A member who may read boards but manages nothing: team scoping binds them. */
const READER = Permission.ORG_READ | Permission.PROJECT_READ | Permission.BOARD_READ;
const memberSession = (permissions = READER): AuthContext => ({
  userId: member, orgId: orgA, orgRole: "MEMBER", permissions, basePermissions: permissions, abacRules: [],
});
const json = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
const item = (orgId: string, projectId: string, extra: { parentId?: string } = {}) =>
  createFixtureWorkItem({
    orgId, projectId, workItemTypeId: typeId, createdById: orgId === orgA ? owner : ownerB, title: tag(), columnKey: "todo", ...extra,
  });
const sprint = (orgId: string, projectId: string) =>
  prisma.interval.create({ data: { orgId, projectId, number: ++n, name: tag(), startDate: new Date("2026-11-02"), endDate: new Date("2026-11-13") } });
const board = (orgId: string, projectId: string, teamId: string | null = null) =>
  prisma.board.create({ data: { orgId, projectId, teamId, name: tag(), type: "KANBAN" } });

beforeAll(async () => {
  const user = async (name: string) => (await prisma.user.create({ data: { email: `${name}-${stamp}@left.test`, displayName: name } })).id;
  [owner, ownerB, member, former] = [await user("owner"), await user("ownerb"), await user("member"), await user("former")];
  orgA = (await prisma.organization.create({ data: { name: `left a ${stamp}`, slug: `left-a-${stamp}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `left b ${stamp}`, slug: `left-b-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId: orgA, userId: owner, role: "OWNER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgA, userId: member, role: "MEMBER", permissions: "0" } });
  await prisma.orgMember.create({ data: { orgId: orgA, userId: former, role: "MEMBER", permissions: "0", removedAt: new Date() } });
  await prisma.orgMember.create({ data: { orgId: orgB, userId: ownerB, role: "OWNER", permissions: "0" } });
  p1 = (await prisma.project.create({ data: { orgId: orgA, name: "P1", key: `LA${K}` } })).id;
  p2 = (await prisma.project.create({ data: { orgId: orgA, name: "P2", key: `LB${K}` } })).id;
  hidden = (await prisma.project.create({ data: { orgId: orgA, name: "Hidden", key: `LC${K}`, teamScopedAccess: true } })).id;
  pB = (await prisma.project.create({ data: { orgId: orgB, name: "PB", key: `LD${K}` } })).id;
  for (const p of [p1, p2, hidden, pB]) await ensureFixtureStatuses(p);
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null, key: { endsWith: ".task" } } })).id;
});

afterAll(async () => {
  await prisma.workItem.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.workItemType.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.boardTemplate.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.theme.deleteMany({ where: { slug: { startsWith: `left-${stamp}` } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: [owner, ownerB, member, former] } } }).catch(() => undefined);
});

describe("a template widget's parent is a widget of the same template", () => {
  const template = (orgId: string) =>
    prisma.boardTemplate.create({ data: { orgId, slug: tag(), name: "T", category: "general" } });
  const widget = (templateId: string, parentWidgetId: string | null = null) =>
    prisma.boardTemplateWidget.create({ data: { templateId, widgetSlug: "chart", parentWidgetId } });
  const sync = (templateId: string, widgets: unknown[]) =>
    syncWidgets(json("PUT", { widgets }), { params: Promise.resolve({ orgId: orgA, templateId }) });
  const parentsOf = async (templateId: string) =>
    (await prisma.boardTemplateWidget.findMany({ where: { templateId }, orderBy: { sortOrder: "asc" } })).map((w) => w.parentWidgetId);

  it.each([
    ["another org's template", async () => widget((await template(orgB)).id)],
    ["another template of this org", async () => widget((await template(orgA)).id)],
  ])("refuses a parent from %s, and the template's widgets are unchanged", async (_why, parentOf) => {
    h.ctx = ownerSession();
    const t = await template(orgA);
    const child = await widget(t.id);
    const parent = await parentOf();
    const res = await sync(t.id, [{ id: child.id, widgetSlug: "chart", parentWidgetId: parent.id, sortOrder: 0 }]);
    expect(res.status).toBe(400);
    expect(await parentsOf(t.id)).toEqual([null]);
    // A new widget naming it is refused the same way, and nothing is created.
    const created = await sync(t.id, [
      { id: child.id, widgetSlug: "chart", sortOrder: 0 },
      { widgetSlug: "chart", parentWidgetId: parent.id, sortOrder: 1 },
    ]);
    expect(created.status).toBe(400);
    expect(await parentsOf(t.id)).toEqual([null]);
  });

  it("refuses a parent the same sync removes", async () => {
    h.ctx = ownerSession();
    const t = await template(orgA);
    const [gone, child] = [await widget(t.id), await widget(t.id)];
    const res = await sync(t.id, [{ id: child.id, widgetSlug: "chart", parentWidgetId: gone.id, sortOrder: 0 }]);
    expect(res.status).toBe(400);
    expect(await prisma.boardTemplateWidget.count({ where: { templateId: t.id } })).toBe(2);
  });

  it("keeps a parent that is one of this template's widgets", async () => {
    h.ctx = ownerSession();
    const t = await template(orgA);
    const [parent, child] = [await widget(t.id), await widget(t.id)];
    const res = await sync(t.id, [
      { id: parent.id, widgetSlug: "chart", sortOrder: 0 },
      { id: child.id, widgetSlug: "chart", parentWidgetId: parent.id, sortOrder: 1 },
      { widgetSlug: "chart", parentWidgetId: parent.id, sortOrder: 2 },
    ]);
    expect(res.status).toBe(200);
    expect(await parentsOf(t.id)).toEqual([null, parent.id, parent.id]);
  });
});

describe("a preference names a board the caller may open, and a theme of this org or a built-in one", () => {
  const put = (body: unknown) => putPreferences(json("PUT", body), { params: Promise.resolve({ orgId: orgA }) });
  const prefs = () => prisma.userPreferences.findUnique({ where: { userId: member } });
  const theme = (orgId: string | null) =>
    prisma.theme.create({ data: { orgId, slug: `left-${stamp}-${++n}`, name: "Theme" } });

  it.each([
    ["another org's board", () => board(orgB, pB)],
    ["a board in a project the caller can't see", () => board(orgA, hidden)],
    ["a board on a team the caller is not on", async () => {
      const team = await prisma.team.create({ data: { orgId: orgA, projectId: p1, name: tag() } });
      return board(orgA, p1, team.id);
    }],
    ["a board id that doesn't exist", async () => ({ id: "00000000-0000-4000-8000-000000000000" })],
  ])("refuses %s as the default board, and stores nothing", async (_why, target) => {
    h.ctx = memberSession();
    const mine = await board(orgA, p1);
    expect((await put({ defaultBoardId: mine.id })).status).toBe(200);
    const res = await put({ defaultBoardId: (await target()).id });
    expect(res.status).toBe(400);
    expect((await prefs())?.defaultBoardId).toBe(mine.id);
  });

  it("refuses a board the caller's role may not read", async () => {
    h.ctx = memberSession(Permission.ORG_READ | Permission.PROJECT_READ);
    const res = await put({ defaultBoardId: (await board(orgA, p1)).id });
    expect(res.status).toBe(400);
  });

  it("keeps a board the caller may open, in any project they can see, and clears to null", async () => {
    h.ctx = memberSession();
    const other = await board(orgA, p2);
    expect((await put({ defaultBoardId: other.id })).status).toBe(200);
    expect((await prefs())?.defaultBoardId).toBe(other.id);
    expect((await put({ defaultBoardId: null })).status).toBe(200);
    expect((await prefs())?.defaultBoardId).toBeNull();
  });

  it("refuses another org's theme, and keeps this org's or a built-in one", async () => {
    h.ctx = memberSession();
    const [mine, builtIn, theirs] = [await theme(orgA), await theme(null), await theme(orgB)];
    expect((await put({ themeId: mine.id })).status).toBe(200);
    expect((await prefs())?.themeId).toBe(mine.id);
    expect((await put({ themeId: theirs.id })).status).toBe(400);
    expect((await prefs())?.themeId).toBe(mine.id);
    expect((await put({ themeId: builtIn.id })).status).toBe(200);
    expect((await prefs())?.themeId).toBe(builtIn.id);
  });
});

describe("a sprint's capacity names current members of the org", () => {
  const put = (intervalId: string, userIds: string[]) =>
    putCapacity(json("PUT", { entries: userIds.map((userId) => ({ userId, capacity: 5 })) }), {
      params: Promise.resolve({ orgId: orgA, projectId: p1, intervalId }),
    });
  const people = async (intervalId: string) =>
    (await prisma.intervalCapacity.findMany({ where: { intervalId } })).map((c) => c.userId).sort();

  it.each([
    ["another org's member", () => ownerB],
    ["a member the org removed", () => former],
  ])("refuses %s, and the sprint's capacity is unchanged", async (_why, who) => {
    h.ctx = ownerSession();
    const s = await sprint(orgA, p1);
    expect((await put(s.id, [member])).status).toBe(200);
    expect((await put(s.id, [member, who()])).status).toBe(400);
    expect(await people(s.id)).toEqual([member]);
  });

  it("stores current members", async () => {
    h.ctx = ownerSession();
    const s = await sprint(orgA, p1);
    expect((await put(s.id, [member, owner])).status).toBe(200);
    expect(await people(s.id)).toEqual([member, owner].sort());
  });
});

describe("updateWorkItems holds the rows an update names to the item's org and project", () => {
  const meta = { actorId: null, source: "SYSTEM" as const };
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it.each<[string, () => Promise<Prisma.WorkItemUncheckedUpdateManyInput>]>([
    ["a parent from another org", async () => ({ parentId: (await item(orgB, pB)).id })],
    ["a parent from another project", async () => ({ parentId: (await item(orgA, p2)).id })],
    ["a sprint from another project", async () => ({ intervalId: (await sprint(orgA, p2)).id })],
    ["a sprint from another org, in the set form", async () => ({ intervalId: { set: (await sprint(orgB, pB)).id } })],
    ["a team from another org", async () => ({ teamId: (await prisma.team.create({ data: { orgId: orgB, projectId: pB, name: tag() } })).id })],
    ["an assignee from another org", async () => ({ assigneeId: ownerB })],
    ["a type from another org", async () => ({ workItemTypeId: (await prisma.workItemType.create({ data: { orgId: orgB, key: `left.${tag()}`, name: "T" } })).id })],
  ])("refuses %s, and writes nothing", async (_why, data) => {
    const rows = [await item(orgA, p1), await item(orgA, p1)];
    const err = await refusal(updateWorkItems(prisma, rows.map((r) => r.id), await data(), meta));
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).status).toBe(400);
    const after = await prisma.workItem.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    expect(after.map((r) => [r.parentId, r.intervalId, r.teamId, r.assigneeId, r.workItemTypeId])).toEqual(
      rows.map(() => [null, null, null, null, typeId]),
    );
  });

  it("refuses through updateWorkItemsUnchecked too, when the caller records its own events", async () => {
    const row = await item(orgA, p1);
    const foreign = await sprint(orgB, pB);
    const err = await refusal(
      prisma.$transaction((tx) => updateWorkItemsUnchecked(tx, [row.id], { intervalId: foreign.id }, RECORDED_BY_CALLER)),
    );
    expect(err).toBeInstanceOf(ProblemError);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: row.id } })).intervalId).toBeNull();
  });

  it("writes rows of the item's own project, an assignee the org removed (history is kept), and clears", async () => {
    const [row, parent] = [await item(orgA, p1), await item(orgA, p1)];
    const s = await sprint(orgA, p1);
    const team = await prisma.team.create({ data: { orgId: orgA, projectId: p1, name: tag() } });
    const data = { parentId: parent.id, intervalId: s.id, teamId: team.id, assigneeId: former };
    expect(await updateWorkItems(prisma, [row.id], data, meta)).toBe(1);
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject(data);
    expect(await updateWorkItems(prisma, [row.id], { parentId: null, intervalId: null, teamId: null, assigneeId: null }, meta)).toBe(1);
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ parentId: null, intervalId: null });
  });

  it("holds a moved item's rows to the project it moves to, and the project to the org", async () => {
    const row = await item(orgA, p1);
    const [inP1, inP2] = [await sprint(orgA, p1), await sprint(orgA, p2)];
    const moveTo = (projectId: string, intervalId: string) => updateWorkItems(prisma, [row.id], { projectId, intervalId }, meta);
    expect(await refusal(moveTo(p2, inP1.id))).toBeInstanceOf(ProblemError);
    expect(await refusal(updateWorkItems(prisma, [row.id], { projectId: pB }, meta))).toBeInstanceOf(ProblemError);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: row.id } })).projectId).toBe(p1);
    expect(await moveTo(p2, inP2.id)).toBe(1);
    expect(await prisma.workItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ projectId: p2, intervalId: inP2.id });
  });

  it("checks items of two projects each against its own project", async () => {
    const [a, b] = [await item(orgA, p1), await item(orgA, p2)];
    const inP1 = await sprint(orgA, p1);
    const err = await refusal(updateWorkItems(prisma, [a.id, b.id], { intervalId: inP1.id }, meta));
    expect(err).toBeInstanceOf(ProblemError);
    expect(await prisma.workItem.count({ where: { id: { in: [a.id, b.id] }, intervalId: inP1.id } })).toBe(0);
  });

  it("costs the same number of queries for 2 items as for 28: none per row", async () => {
    const s = await sprint(orgA, p1);
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(await item(orgA, p1));
    /** How many queries one update issues: every model call and raw query, counted on the transaction. */
    const queries = async (ids: string[], data: Prisma.WorkItemUncheckedUpdateManyInput, how: typeof meta | typeof RECORDED_BY_CALLER) => {
      let count = 0;
      const counting = <T extends object>(obj: T): T =>
        new Proxy(obj, {
          get(target, op) {
            const fn = Reflect.get(target, op);
            return typeof fn === "function" ? (...args: unknown[]) => (count++, fn.apply(target, args)) : fn;
          },
        });
      await prisma.$transaction(async (tx) => {
        const counted: Prisma.TransactionClient = new Proxy(tx, {
          get(target, prop) {
            // A nested transaction joins this one: hand back the counted client.
            if (prop === "$transaction") return (fn: (t: Prisma.TransactionClient) => unknown) => fn(counted);
            const value = Reflect.get(target, prop);
            if (typeof prop !== "string") return value;
            if (prop.startsWith("$")) return typeof value === "function" ? counting(value.bind(target)) : value;
            return value && typeof value === "object" ? counting(value) : value;
          },
        });
        expect(await updateWorkItems(counted, ids, data, how)).toBe(ids.length);
      });
      return count;
    };
    const few = await queries(rows.slice(0, 2).map((r) => r.id), { intervalId: s.id }, meta);
    const many = await queries(rows.slice(2).map((r) => r.id), { intervalId: s.id }, meta);
    // Snapshot, update, snapshot and events, plus the check: positive, so the counter counts.
    expect(few).toBeGreaterThan(4);
    expect(many).toBe(few);
    // A write that names no other row adds no query: the update alone.
    expect(await queries([rows[0].id], { storyPoints: 3 }, RECORDED_BY_CALLER)).toBe(1);
  });
});
