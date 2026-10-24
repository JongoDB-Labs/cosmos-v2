// @vitest-environment node
//
// PARITY SUITE for the single work-item writer (workflow design §10.2).
//
// Every scenario drives a PUBLIC entry point (the PUT / POST / bulk routes, the
// assistant executors, the merge service, sprint completion) against a real
// database and snapshots what it leaves behind: the item row, its Activity
// history (which is also the date audit), its assignee and label rows, any
// column the cancel path had to create, and every after-commit side effect
// (audit, realtime, notifications, Teams, embeddings).
//
// The snapshots were RECORDED FROM THE CODE BEFORE the refactor that moved these
// paths onto `applyWorkItemChange`, and committed first. The refactor then had to
// reproduce them. Where it does not, the difference is intended and listed here;
// each one carries a changelog line:
//
//   INTENDED DIFFS
//   - bulk: "bulk move into Done", "bulk assignee change": a bulk edit now does
//     what a single edit does (dates, cancel fields, history, the assignee SET,
//     the same notification text), plus one Teams line for the whole move.
//   - assistant: "assistant move into Review", "assistant move into a custom
//     Done column", "assistant move out of done", "assistant tag edit",
//     "assistant reassignment": done/started follow the column CATEGORY instead
//     of the key's spelling, the edit is recorded in history, audited,
//     published and notified like a PUT, and tags go through the label catalogue.
//   - sprint: "sprint completion counts a custom Done column as done".
//   - merge: "merge a duplicate": the move to Cancelled is recorded in history.
//   - statuses (P1): "move to a key that is not a status is refused": a key must
//     name one of the project's statuses, so a 400 and no change, where the item
//     used to land on a key no board showed and drop out of every view.
//   - workflow engine (P2): that move is now the workflow's refusal, a 409
//     `transition_not_allowed` problem, before anything is written. A cancel
//     records its reason as the item's resolution ("cancel with OBE…", "cancel
//     with OTHER…", "cancel naming an existing Cancelled column…", "cancelling
//     an item already cancelled…"), a merge records "Duplicate" ("merge a
//     duplicate"), and a bulk response lists the items the workflow refused
//     (`denied`, empty in "bulk move into Done", "bulk assignee change", "bulk tags").
//
// Ids and "now" are normalised (see `norm`), so a snapshot shows names, not
// uuids, and `<now>` for any timestamp taken during the scenario.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, type ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { stubToolCtx } from "@/lib/testing/tool-auth";

const calls = vi.hoisted(() => ({
  audit: [] as unknown[],
  publish: [] as unknown[],
  notify: [] as unknown[],
  teams: [] as unknown[],
  embed: [] as unknown[],
  ctx: null as unknown,
}));

vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(async (e: Record<string, unknown>) => {
    // The IP is the request's, not the change's.
    const rest = { ...e };
    delete rest.ipAddress;
    calls.audit.push(rest);
  }),
}));
vi.mock("@/lib/realtime/broker", () => ({
  publishToOrg: vi.fn((...args: unknown[]) => void calls.publish.push(args)),
}));
vi.mock("@/lib/notifications/create", () => ({
  createNotification: vi.fn(async (n: unknown) => void calls.notify.push(n)),
}));
vi.mock("@/lib/integrations/teams-notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/teams-notify")>()),
  teamsNotify: vi.fn(async (...args: unknown[]) => void calls.teams.push(args)),
}));
vi.mock("@/lib/rag/embed", () => ({
  storeEmbedding: vi.fn(async (table: string, id: string) => void calls.embed.push([table, id])),
}));

import { PUT as putItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/[itemId]/route";
import { POST as createItem } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route";
import { PUT as bulkPut } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/bulk/route";
import { POST as completeInterval } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/complete/route";
import { updateWorkItem as aiUpdate, createWorkItem as aiCreate } from "@/lib/ai/executors/work-items";
import { mergeWorkItems } from "@/lib/work-items/merge.server";
import { WORK_ITEM_HIGHLIGHT_ORDER } from "@/lib/work-items/highlights";
import { seedBoardColumns } from "@/lib/workflow/provision.server";

// ─── Fixture world ──────────────────────────────────────────────────────────

const COLUMNS: Array<{ key: string; name: string; category: ColumnCategory }> = [
  { key: "backlog", name: "Backlog", category: "TODO" },
  { key: "todo", name: "To Do", category: "TODO" },
  { key: "in_progress", name: "In Progress", category: "IN_PROGRESS" },
  { key: "review", name: "Review", category: "IN_PROGRESS" },
  { key: "done", name: "Done", category: "DONE" },
  // A team-named done lane: its key contains none of done/completed/closed.
  { key: "shipped", name: "Shipped", category: "DONE" },
];

const T1 = new Date("2026-01-10T12:00:00.000Z");
const T2 = new Date("2026-02-20T12:00:00.000Z");

let orgId = "";
let aliceId = "";
let bobId = "";
let typeId = "";
const projectIds: string[] = [];
const typeIds: string[] = [];
const names = new Map<string, string>();
/** Each scenario's project key is random; snapshots show it as PROJ. */
const projectKeys = new Set<string>();
let scenarioStart = 0;

function allPermissions(): bigint {
  return Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "test-org" } });
  orgId = org.id;
  aliceId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  bobId = (await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } })).id;
  typeId = (
    await prisma.workItemType.findFirstOrThrow({
      where: { isBuiltIn: true, key: "software.task" },
    })
  ).id;
  names.set(orgId, "org");
  names.set(aliceId, "alice");
  names.set(bobId, "bob");
  names.set(typeId, "type:task");
  calls.ctx = {
    userId: aliceId,
    orgId,
    orgRole: OrgRole.OWNER,
    permissions: allPermissions(),
    basePermissions: allPermissions(),
    abacRules: [],
  } satisfies AuthContext;
});

afterAll(async () => {
  // work_items has no foreign key to projects, so items go first (their history,
  // assignees and labels cascade with them); the project then takes its boards,
  // columns, intervals and teams.
  await prisma.workItem.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.workItemType.deleteMany({ where: { id: { in: typeIds } } });
});

beforeEach(() => {
  calls.audit.length = 0;
  calls.publish.length = 0;
  calls.notify.length = 0;
  calls.teams.length = 0;
  calls.embed.length = 0;
  scenarioStart = Date.now();
});

interface World {
  projectId: string;
  boardId: string;
  item: (name: string, data?: Record<string, unknown>) => Promise<string>;
}

/** A fresh project per scenario: one Kanban board with COLUMNS, nothing else. */
async function world(opts: { columns?: typeof COLUMNS } = {}): Promise<World> {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const project = await prisma.project.create({
    data: { orgId, name: `parity ${suffix}`, key: `PAR${suffix}` },
  });
  projectIds.push(project.id);
  projectKeys.add(project.key);
  names.set(project.id, "project");
  const board = await prisma.board.create({
    data: {
      orgId,
      projectId: project.id,
      name: "Kanban",
      type: "KANBAN",
    },
  });
  // Through the provisioning path, so every column's status exists (a work
  // item's key must name one).
  await seedBoardColumns(prisma, board, opts.columns ?? COLUMNS);
  names.set(board.id, "board");
  let ticket = 0;
  return {
    projectId: project.id,
    boardId: board.id,
    async item(name, data = {}) {
      const row = await prisma.workItem.create({
        data: {
          orgId,
          projectId: project.id,
          workItemTypeId: typeId,
          createdById: aliceId,
          title: name,
          columnKey: "todo",
          ticketNumber: ++ticket,
          columnEnteredAt: T1,
          ...data,
        },
      });
      names.set(row.id, `item:${name}`);
      return row.id;
    },
  };
}

// ─── Snapshot normalisation ─────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function normTime(ms: number, original: string): string {
  return ms >= scenarioStart - 1000 && ms <= Date.now() + 1000 ? "<now>" : original;
}

function norm(value: unknown): unknown {
  if (value instanceof Date) return normTime(value.getTime(), value.toISOString());
  if (typeof value === "string") {
    if (UUID.test(value)) return names.get(value) ?? "<unknown-id>";
    if (ISO.test(value)) return normTime(Date.parse(value), value);
    // Ids and project keys embedded in text (URLs, ticket refs).
    let text = value;
    for (const key of projectKeys) text = text.split(key).join("PROJ");
    return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => names.get(m) ?? "<unknown-id>");
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v)]));
  }
  return value;
}

/** Everything a change can leave behind on one item. */
async function itemState(id: string) {
  const row = await prisma.workItem.findUniqueOrThrow({
    where: { id },
    select: {
      title: true,
      description: true,
      columnKey: true,
      columnEnteredAt: true,
      actualStart: true,
      completedAt: true,
      cancelReason: true,
      cancelNote: true,
      mergedIntoId: true,
      assigneeId: true,
      priority: true,
      intervalId: true,
      teamId: true,
      parentId: true,
      storyPoints: true,
      startDate: true,
      dueDate: true,
      archivedAt: true,
      highlight: true,
      tags: true,
      customFields: true,
      workCategory: true,
      assignees: { select: { userId: true, sortOrder: true }, orderBy: [{ sortOrder: "asc" }, { userId: "asc" }] },
      labels: { select: { label: { select: { name: true } } } },
    },
  });
  const activity = await prisma.activity.findMany({
    where: { workItemId: id },
    select: { action: true, field: true, oldValue: true, newValue: true, userId: true },
  });
  activity.sort((a, b) =>
    [a.action, a.field, a.oldValue, a.newValue].join("|").localeCompare([b.action, b.field, b.oldValue, b.newValue].join("|")),
  );
  return {
    ...row,
    labels: row.labels.map((l) => l.label.name).sort(),
    activity,
  };
}

async function columnsOf(projectId: string) {
  const boards = await prisma.board.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { columns: { select: { key: true, name: true, category: true, sortOrder: true }, orderBy: { sortOrder: "asc" } } },
  });
  return boards.map((b) => b.columns);
}

async function flush() {
  // Teams fires from a detached async block after the response.
  await new Promise((r) => setTimeout(r, 30));
}

async function sideEffects() {
  await flush();
  return {
    audit: calls.audit,
    publish: calls.publish,
    notify: calls.notify,
    teams: calls.teams,
    embed: calls.embed,
  };
}

// ─── Entry points ───────────────────────────────────────────────────────────

async function put(w: World, itemId: string, body: Record<string, unknown>) {
  const res = await putItem(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${w.projectId}/work-items/${itemId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId, projectId: w.projectId, itemId }) },
  );
  expect(res.status, "PUT rejected the scenario's request").toBe(200);
  const json = await res.json();
  return {
    status: res.status,
    echo: {
      columnKey: json.columnKey,
      completedAt: json.completedAt,
      actualStart: json.actualStart,
      tags: json.tags,
      assignees: json.assignees?.map((a: { userId: string }) => a.userId),
      children: json.children?.map((c: { id: string }) => c.id),
      scheduleCascade: json.scheduleCascade,
    },
  };
}

async function bulk(w: World, ids: string[], update: Record<string, unknown>) {
  const res = await bulkPut(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${w.projectId}/work-items/bulk`, {
      method: "PUT",
      body: JSON.stringify({ ids, update }),
    }),
    { params: Promise.resolve({ orgId, projectId: w.projectId }) },
  );
  expect(res.status, "bulk PUT rejected the scenario's request").toBe(200);
  return { status: res.status, body: await res.json() };
}

async function create(w: World, body: Record<string, unknown>) {
  const res = await createItem(
    new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${w.projectId}/work-items`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId, projectId: w.projectId }) },
  );
  expect(res.status, "POST rejected the scenario's request").toBe(201);
  const json = await res.json();
  if (json?.id) names.set(json.id, "item:created");
  return { status: res.status, id: json?.id as string | undefined };
}

// ─── Scenarios: the single-item PUT ─────────────────────────────────────────

describe("parity: PUT /work-items/[itemId]", () => {
  it("move todo → in_progress stamps actual start", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { columnKey: "in_progress" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move todo → review (IN_PROGRESS by category, not by key)", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { columnKey: "review" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move in_progress → done stamps completion, keeps start", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "in_progress", actualStart: T1 });
    const res = await put(w, a, { columnKey: "done" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move todo → custom done lane stamps both dates", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { columnKey: "shipped" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move done → todo clears completion, keeps start", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "done", actualStart: T1, completedAt: T2 });
    const res = await put(w, a, { columnKey: "todo" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move done → another done lane keeps completion", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "done", actualStart: T1, completedAt: T2 });
    const res = await put(w, a, { columnKey: "shipped" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("same column is not a move", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "done", completedAt: T2 });
    const res = await put(w, a, { columnKey: "done" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move into done with a manual completedAt: the manual value wins", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { columnKey: "done", completedAt: T1.toISOString() });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move into done with completedAt: null: the manual null wins", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { columnKey: "done", completedAt: null });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move into in_progress with a manual actualStart", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { columnKey: "in_progress", actualStart: T2.toISOString() });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("move to a key that is not a status is refused", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "done", completedAt: T2 });
    const res = await putItem(
      new NextRequest(`http://localhost/api/v1/orgs/${orgId}/projects/${w.projectId}/work-items/${a}`, {
        method: "PUT",
        body: JSON.stringify({ columnKey: "ghost" }),
      }),
      { params: Promise.resolve({ orgId, projectId: w.projectId, itemId: a }) },
    );
    const body = { status: res.status, ...(await res.json()) };
    expect(norm({ res: body, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("cancel with OBE creates the Cancelled column on first use", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "in_progress", actualStart: T1 });
    const res = await put(w, a, { cancelReason: "OBE" });
    expect(
      norm({ res, item: await itemState(a), columns: await columnsOf(w.projectId), effects: await sideEffects() }),
    ).toMatchSnapshot();
  });

  it("cancel with OTHER and a note, from done", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "done", actualStart: T1, completedAt: T2 });
    const res = await put(w, a, { cancelReason: "OTHER", cancelNote: "  superseded by the new plan  " });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("reopening a cancelled item clears the reason", async () => {
    const w = await world({ columns: [...COLUMNS, { key: "cancelled", name: "Cancelled", category: "CANCELLED" }] });
    const a = await w.item("A", { columnKey: "cancelled", cancelReason: "OBE", cancelNote: "gone" });
    const res = await put(w, a, { columnKey: "todo" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("reopening a merged item un-merges it", async () => {
    const w = await world({ columns: [...COLUMNS, { key: "cancelled", name: "Cancelled", category: "CANCELLED" }] });
    const b = await w.item("B");
    const a = await w.item("A", { columnKey: "cancelled", cancelReason: "MERGED", cancelNote: "Merged", mergedIntoId: b });
    const res = await put(w, a, { columnKey: "in_progress" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("title and description edit", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { title: "A renamed", description: "now with words" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assign to someone else notifies them", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { assigneeId: bobId });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assignee set replaced wholesale", async () => {
    const w = await world();
    const a = await w.item("A", { assigneeId: bobId, assignees: { create: [{ userId: bobId, sortOrder: 0 }] } });
    const res = await put(w, a, { assigneeIds: [aliceId, bobId] });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("unassign clears the whole set", async () => {
    const w = await world();
    const a = await w.item("A", {
      assigneeId: bobId,
      assignees: { create: [{ userId: bobId, sortOrder: 0 }, { userId: aliceId, sortOrder: 1 }] },
    });
    const res = await put(w, a, { assigneeId: null });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("priority, interval, team, points, highlight, work category, archive", async () => {
    const w = await world();
    const interval = await prisma.interval.create({
      data: { orgId, projectId: w.projectId, number: 1, name: "Sprint 1", startDate: T1, endDate: T2 },
    });
    names.set(interval.id, "interval");
    const team = await prisma.team.create({ data: { orgId, projectId: w.projectId, name: "Blue" } });
    names.set(team.id, "team");
    const a = await w.item("A");
    const res = await put(w, a, {
      priority: "HIGH",
      intervalId: interval.id,
      teamId: team.id,
      storyPoints: 5,
      highlight: WORK_ITEM_HIGHLIGHT_ORDER[0],
      workCategory: "ENABLER",
      archivedAt: T2.toISOString(),
    });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("tags go through the label catalogue", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { tags: ["parity-alpha", "parity-beta"] });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("custom fields merge into the existing values", async () => {
    const w = await world();
    const a = await w.item("A", { customFields: { keep: "me", change: 1 } });
    const res = await put(w, a, { customFields: { change: 2, added: true } });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("a due-date slip cascades to the parent and a successor", async () => {
    const w = await world();
    const parent = await w.item("P", { startDate: T1, dueDate: new Date("2026-01-20T12:00:00.000Z") });
    const a = await w.item("A", { parentId: parent, startDate: T1, dueDate: new Date("2026-01-15T12:00:00.000Z") });
    const succ = await w.item("S", { startDate: new Date("2026-01-16T12:00:00.000Z"), dueDate: new Date("2026-01-18T12:00:00.000Z") });
    await prisma.workItemLink.create({ data: { orgId, sourceItemId: a, targetItemId: succ, type: "BLOCKS" } });
    const res = await put(w, a, { dueDate: "2026-01-25T12:00:00.000Z" });
    expect(
      norm({
        res,
        item: await itemState(a),
        parent: await itemState(parent),
        successor: await itemState(succ),
        effects: await sideEffects(),
      }),
    ).toMatchSnapshot();
  });
});

describe("parity: PUT /work-items/[itemId], every remaining field and edge", () => {
  it("type change, parent change, sort order, null description", async () => {
    const w = await world();
    const story = (
      await prisma.workItemType.create({
        data: { orgId, key: `parity.story.${Math.random().toString(36).slice(2, 8)}`, name: "Story" },
      })
    ).id;
    names.set(story, "type:story");
    typeIds.push(story);
    const parent = await w.item("P");
    const a = await w.item("A", { description: "old" });
    const res = await put(w, a, { workItemTypeId: story, parentId: parent, sortOrder: 42, description: null });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("clearing parent, interval, team, points, highlight and archive", async () => {
    const w = await world();
    const interval = await prisma.interval.create({
      data: { orgId, projectId: w.projectId, number: 1, name: "Sprint 1", startDate: T1, endDate: T2 },
    });
    names.set(interval.id, "interval");
    const team = await prisma.team.create({ data: { orgId, projectId: w.projectId, name: "Blue" } });
    names.set(team.id, "team");
    const parent = await w.item("P");
    const a = await w.item("A", {
      parentId: parent,
      intervalId: interval.id,
      teamId: team.id,
      storyPoints: 3,
      highlight: WORK_ITEM_HIGHLIGHT_ORDER[0],
      archivedAt: T2,
    });
    const res = await put(w, a, {
      parentId: null,
      intervalId: null,
      teamId: null,
      storyPoints: null,
      highlight: null,
      archivedAt: null,
    });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assigning yourself sends no notification", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, { assigneeId: aliceId });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("re-assigning to the same person keeps the set and notifies nobody", async () => {
    const w = await world();
    const a = await w.item("A", {
      assigneeId: bobId,
      assignees: { create: [{ userId: aliceId, sortOrder: 0 }, { userId: bobId, sortOrder: 1 }] },
    });
    const res = await put(w, a, { assigneeId: bobId });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("empty assignee set clears the primary", async () => {
    const w = await world();
    const a = await w.item("A", { assigneeId: bobId, assignees: { create: [{ userId: bobId, sortOrder: 0 }] } });
    const res = await put(w, a, { assigneeIds: [] });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("clearing every tag", async () => {
    const w = await world();
    const a = await w.item("A");
    await put(w, a, { tags: ["parity-zeta"] });
    calls.audit.length = 0;
    calls.publish.length = 0;
    const res = await put(w, a, { tags: [] });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("cancel naming an existing Cancelled column keeps that column", async () => {
    const w = await world({
      columns: [
        ...COLUMNS,
        { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
        { key: "wontdo", name: "Won't do", category: "CANCELLED" },
      ],
    });
    const a = await w.item("A");
    const res = await put(w, a, { cancelReason: "OBE", columnKey: "wontdo" });
    expect(
      norm({ res, item: await itemState(a), columns: await columnsOf(w.projectId), effects: await sideEffects() }),
    ).toMatchSnapshot();
  });

  it("cancelling an item already cancelled only changes the reason", async () => {
    const w = await world({ columns: [...COLUMNS, { key: "cancelled", name: "Cancelled", category: "CANCELLED" }] });
    const a = await w.item("A", { columnKey: "cancelled", cancelReason: "OBE" });
    const res = await put(w, a, { cancelReason: "OTHER", cancelNote: "actually, other" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("moving between two Cancelled columns keeps the reason", async () => {
    const w = await world({
      columns: [
        ...COLUMNS,
        { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
        { key: "wontdo", name: "Won't do", category: "CANCELLED" },
      ],
    });
    const a = await w.item("A", { columnKey: "cancelled", cancelReason: "OBE", cancelNote: "n" });
    const res = await put(w, a, { columnKey: "wontdo" });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("a status move and field edits in one request", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "in_progress", actualStart: T1 });
    const res = await put(w, a, {
      columnKey: "done",
      title: "A done",
      priority: "LOW",
      assigneeId: bobId,
      dueDate: "2026-03-01T12:00:00.000Z",
      customFields: { k: 1 },
    });
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("a start-date pull-in moves no successor", async () => {
    const w = await world();
    const a = await w.item("A", { startDate: T1, dueDate: new Date("2026-01-15T12:00:00.000Z") });
    const succ = await w.item("S", { startDate: new Date("2026-01-16T12:00:00.000Z"), dueDate: new Date("2026-01-18T12:00:00.000Z") });
    await prisma.workItemLink.create({ data: { orgId, sourceItemId: a, targetItemId: succ, type: "BLOCKS" } });
    const res = await put(w, a, { startDate: "2026-01-05T12:00:00.000Z", dueDate: "2026-01-12T12:00:00.000Z" });
    expect(
      norm({ res, item: await itemState(a), successor: await itemState(succ), effects: await sideEffects() }),
    ).toMatchSnapshot();
  });

  it("cascadeSkipIds keeps a co-edited successor where it is", async () => {
    const w = await world();
    const a = await w.item("A", { startDate: T1, dueDate: new Date("2026-01-15T12:00:00.000Z") });
    const succ = await w.item("S", { startDate: new Date("2026-01-16T12:00:00.000Z"), dueDate: new Date("2026-01-18T12:00:00.000Z") });
    await prisma.workItemLink.create({ data: { orgId, sourceItemId: a, targetItemId: succ, type: "BLOCKS" } });
    const res = await put(w, a, { dueDate: "2026-01-25T12:00:00.000Z", cascadeSkipIds: [succ] });
    expect(
      norm({ res, item: await itemState(a), successor: await itemState(succ), effects: await sideEffects() }),
    ).toMatchSnapshot();
  });

  it("an empty body changes nothing but is still audited", async () => {
    const w = await world();
    const a = await w.item("A");
    const res = await put(w, a, {});
    expect(norm({ res, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });
});

// ─── Scenarios: create ──────────────────────────────────────────────────────

describe("parity: create", () => {
  it("POST creates with assignees, labels and history", async () => {
    const w = await world();
    const res = await create(w, {
      title: "Created",
      columnKey: "in_progress",
      workItemTypeId: typeId,
      assigneeIds: [bobId],
      tags: ["parity-gamma"],
      priority: "LOW",
    });
    expect(norm({ status: res.status, item: await itemState(res.id!), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assistant create lands in the requested status", async () => {
    const w = await world();
    const out = (await aiCreate(
      { projectId: w.projectId, title: "From Cosmo", columnKey: "backlog", workItemTypeId: typeId },
      stubToolCtx(orgId, aliceId, { orgRole: OrgRole.OWNER, permissions: allPermissions() }),
    )) as { id: string };
    names.set(out.id, "item:ai");
    expect(norm({ out, item: await itemState(out.id), effects: await sideEffects() })).toMatchSnapshot();
  });
});

// ─── Scenarios: bulk ────────────────────────────────────────────────────────

describe("parity: bulk", () => {
  it("bulk move into Done", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "in_progress", actualStart: T1 });
    const b = await w.item("B");
    const res = await bulk(w, [a, b], { columnKey: "done" });
    expect(
      norm({ res, a: await itemState(a), b: await itemState(b), effects: await sideEffects() }),
    ).toMatchSnapshot();
  });

  it("bulk assignee change", async () => {
    const w = await world();
    const a = await w.item("A");
    const b = await w.item("B", { assigneeId: bobId, assignees: { create: [{ userId: bobId, sortOrder: 0 }] } });
    const res = await bulk(w, [a, b], { assigneeId: bobId, priority: "HIGH" });
    expect(
      norm({ res, a: await itemState(a), b: await itemState(b), effects: await sideEffects() }),
    ).toMatchSnapshot();
  });

  it("bulk tags", async () => {
    const w = await world();
    const a = await w.item("A");
    const b = await w.item("B");
    const res = await bulk(w, [a, b], { tags: ["parity-delta"] });
    expect(
      norm({ res, a: await itemState(a), b: await itemState(b), effects: await sideEffects() }),
    ).toMatchSnapshot();
  });
});

// ─── Scenarios: the assistant ───────────────────────────────────────────────

describe("parity: assistant updateWorkItem", () => {
  it("assistant move into Review", async () => {
    const w = await world();
    const a = await w.item("A");
    const out = await aiUpdate({ itemId: a, columnKey: "review" }, stubToolCtx(orgId, aliceId, { orgRole: OrgRole.OWNER, permissions: allPermissions() }));
    expect(norm({ out, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assistant move into a custom Done column", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "in_progress", actualStart: T1 });
    const out = await aiUpdate({ itemId: a, columnKey: "shipped" }, stubToolCtx(orgId, aliceId, { orgRole: OrgRole.OWNER, permissions: allPermissions() }));
    expect(norm({ out, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assistant move out of done", async () => {
    const w = await world();
    const a = await w.item("A", { columnKey: "done", actualStart: T1, completedAt: T2 });
    const out = await aiUpdate({ itemId: a, columnKey: "todo" }, stubToolCtx(orgId, aliceId, { orgRole: OrgRole.OWNER, permissions: allPermissions() }));
    expect(norm({ out, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assistant tag edit", async () => {
    const w = await world();
    const a = await w.item("A");
    const out = await aiUpdate({ itemId: a, tags: ["parity-epsilon"] }, stubToolCtx(orgId, aliceId, { orgRole: OrgRole.OWNER, permissions: allPermissions() }));
    expect(norm({ out, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });

  it("assistant reassignment", async () => {
    const w = await world();
    const a = await w.item("A", { assigneeId: aliceId, assignees: { create: [{ userId: aliceId, sortOrder: 0 }] } });
    const out = await aiUpdate({ itemId: a, assigneeId: bobId, priority: "HIGH" }, stubToolCtx(orgId, aliceId, { orgRole: OrgRole.OWNER, permissions: allPermissions() }));
    expect(norm({ out, item: await itemState(a), effects: await sideEffects() })).toMatchSnapshot();
  });
});

// ─── Scenarios: merge and sprint completion ─────────────────────────────────

describe("parity: merge and sprint", () => {
  it("merge a duplicate", async () => {
    const w = await world();
    const a = await w.item("Dup", { columnKey: "in_progress", actualStart: T1, description: "dup text", tags: [] });
    const b = await w.item("Survivor");
    const result = await prisma.$transaction((tx) =>
      mergeWorkItems(tx, { orgId, projectId: w.projectId, duplicateId: a, survivorId: b, userId: aliceId }),
    );
    expect(
      norm({
        result,
        dup: await itemState(a),
        survivor: await itemState(b),
        columns: await columnsOf(w.projectId),
      }),
    ).toMatchSnapshot();
  });

  it("sprint completion counts a 'completed' lane stored as TODO as done", async () => {
    // TODO is the column default (templates and the columns API store it when
    // no category is given), so a done lane may carry it.
    const w = await world({ columns: [...COLUMNS, { key: "completed", name: "Completed", category: "TODO" }] });
    const interval = await prisma.interval.create({
      data: { orgId, projectId: w.projectId, number: 1, name: "Sprint 1", startDate: T1, endDate: T2, status: "ACTIVE" },
    });
    names.set(interval.id, "interval");
    const finished = await w.item("Finished", { columnKey: "completed", intervalId: interval.id, storyPoints: 3 });
    const open = await w.item("Open", { columnKey: "in_progress", intervalId: interval.id, storyPoints: 2 });
    const res = await completeInterval(
      new NextRequest(`http://localhost/x`, { method: "POST", body: JSON.stringify({}) }),
      { params: Promise.resolve({ orgId, projectId: w.projectId, intervalId: interval.id }) },
    );
    const row = await prisma.interval.findUniqueOrThrow({ where: { id: interval.id }, select: { report: true } });
    expect(
      norm({
        status: res.status,
        report: row.report,
        finished: (await itemState(finished)).intervalId,
        open: (await itemState(open)).intervalId,
      }),
    ).toMatchSnapshot();
  });

  it("sprint completion counts a custom Done column as done", async () => {
    const w = await world();
    const interval = await prisma.interval.create({
      data: { orgId, projectId: w.projectId, number: 1, name: "Sprint 1", startDate: T1, endDate: T2, status: "ACTIVE" },
    });
    names.set(interval.id, "interval");
    const done = await w.item("Done", { columnKey: "done", intervalId: interval.id, completedAt: T2 });
    const shipped = await w.item("Shipped", { columnKey: "shipped", intervalId: interval.id, completedAt: T2 });
    const open = await w.item("Open", { columnKey: "in_progress", intervalId: interval.id });
    const res = await completeInterval(
      new NextRequest(`http://localhost/x`, { method: "POST", body: JSON.stringify({}) }),
      { params: Promise.resolve({ orgId, projectId: w.projectId, intervalId: interval.id }) },
    );
    const row = await prisma.interval.findUniqueOrThrow({ where: { id: interval.id }, select: { report: true } });
    expect(
      norm({
        status: res.status,
        report: row.report,
        done: (await itemState(done)).intervalId,
        shipped: (await itemState(shipped)).intervalId,
        open: (await itemState(open)).intervalId,
      }),
    ).toMatchSnapshot();
  });
});
