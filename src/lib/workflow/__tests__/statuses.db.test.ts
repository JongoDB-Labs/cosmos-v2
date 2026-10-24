// @vitest-environment node
//
// A project's statuses (`workflow_statuses`) and the board columns that show
// them, against a real database: the foreign key from work_items is what makes
// these rules matter, so they are tested where it applies.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole, type BoardType } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

const calls = vi.hoisted(() => ({ ctx: null as unknown, audit: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: vi.fn(async () => calls.ctx) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => void calls.audit.push(e)) }));

import { seedBoardColumns } from "../provision.server";
import { ensureCancelledStatus, ensureStatuses, loadStatuses, renameStatusIfUnshared } from "../statuses.server";
import { GET as listStatuses, POST as createStatus } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/statuses/route";
import { PATCH as patchStatus, DELETE as deleteStatus } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/statuses/[key]/route";
import { PUT as putColumns } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/columns/route";
import { GET as getBoard } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/route";
import { GET as listBoards } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import { GET as listConflicts, POST as resolveConflict } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/workflow/conflicts/route";

let orgId = "";
let userId = "";
let typeId = "";
let ticket = 0;

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  orgId = (await prisma.organization.create({ data: { name: `wfs ${stamp}`, slug: `wfs-${stamp}` } })).id;
  typeId = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  const all = Object.values(Permission).reduce((acc, bit) => acc | bit, 0n);
  calls.ctx = {
    userId, orgId, orgRole: OrgRole.OWNER, permissions: all, basePermissions: all, abacRules: [],
  } satisfies AuthContext;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
});

const COLS = [
  { key: "todo", name: "To Do", category: "TODO" as const },
  { key: "doing", name: "Doing", category: "IN_PROGRESS" as const },
  { key: "done", name: "Done", category: "DONE" as const },
];

async function project() {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return prisma.project.create({ data: { orgId, name: `S ${suffix}`, key: `S${suffix}` } });
}

async function board(projectId: string, type: BoardType, columns: Parameters<typeof seedBoardColumns>[2] = COLS) {
  const b = await prisma.board.create({ data: { orgId, projectId, name: type, type } });
  await prisma.$transaction((tx) => seedBoardColumns(tx, b, columns));
  return b;
}

function item(projectId: string, columnKey: string) {
  return prisma.workItem.create({
    data: {
      orgId, projectId, columnKey, workItemTypeId: typeId, createdById: userId,
      title: columnKey, description: "", ticketNumber: ++ticket,
    },
  });
}

const statusesOf = async (projectId: string) =>
  (await loadStatuses(prisma, projectId, { includeArchived: true })).map((s) => ({
    key: s.key, name: s.name, category: s.category, archived: s.archivedAt !== null,
  }));
/** A board's columns as the board API answers them: each with its status's category. */
async function servedColumnsOf(projectId: string, boardId: string): Promise<{ key: string; category: string }[]> {
  const res = await getBoard(req("GET"), { params: Promise.resolve({ orgId, projectId, boardId }) });
  return (await res.json()).columns;
}
const columnsOf = (boardId: string) =>
  prisma.boardColumn.findMany({ where: { boardId }, orderBy: { sortOrder: "asc" }, select: { key: true, name: true, category: true } });

function req(method: string, body?: unknown, query = "") {
  return new NextRequest(`http://localhost/x${query}`, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

describe("seedBoardColumns", () => {
  it("creates each column's status before the column, and the first board decides a shared key's category", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    // A second board names "done" with another category: it shows the status
    // that already exists rather than redefining it.
    const table = await board(p.id, "TABLE", [{ key: "done", name: "Finished", category: "TODO" }]);

    expect(await statusesOf(p.id)).toEqual([
      { key: "todo", name: "To Do", category: "TODO", archived: false },
      { key: "doing", name: "Doing", category: "IN_PROGRESS", archived: false },
      { key: "done", name: "Done", category: "DONE", archived: false },
    ]);
    expect(await columnsOf(kanban.id)).toHaveLength(3);
    expect(await columnsOf(table.id)).toEqual([{ key: "done", name: "Finished", category: "DONE" }]);
  });

  it("gives a ceremony board its prompts without making them statuses", async () => {
    const p = await project();
    await board(p.id, "SPRINT_REVIEW", [{ key: "went-well", name: "Went well" }]);
    expect(await statusesOf(p.id)).toEqual([]);
  });
});

describe("work items and statuses", () => {
  it("refuses an item in a key that is not one of its project's statuses", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    await expect(item(p.id, "ghost")).rejects.toMatchObject({ code: "P2003" });
    await expect(item(p.id, "todo")).resolves.toBeTruthy();
  });

  it("removes a project's items with the project", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    const it1 = await item(p.id, "todo");
    await prisma.project.delete({ where: { id: p.id } });
    expect(await prisma.workItem.findUnique({ where: { id: it1.id } })).toBeNull();
  });
});

describe("ensureStatuses", () => {
  it("keeps an existing status's name and writes its category only when asked, which status boards then show", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const planning = await board(p.id, "SPRINT_PLANNING", [{ key: "doing", name: "Doing prompt", category: "TODO" }]);

    await prisma.$transaction((tx) =>
      ensureStatuses(tx, { orgId, projectId: p.id }, [{ key: "doing", name: "Renamed", category: "DONE" }]),
    );
    expect((await statusesOf(p.id)).find((s) => s.key === "doing")).toMatchObject({ name: "Doing", category: "IN_PROGRESS" });

    await prisma.$transaction((tx) =>
      ensureStatuses(tx, { orgId, projectId: p.id }, [{ key: "doing", name: "Renamed", category: "DONE" }], { writeCategory: true }),
    );
    expect((await statusesOf(p.id)).find((s) => s.key === "doing")).toMatchObject({ name: "Doing", category: "DONE" });
    // The board answers with the status's category; the ceremony board's prompt is no status.
    expect((await servedColumnsOf(p.id, kanban.id)).find((c) => c.key === "doing")?.category).toBe("DONE");
    expect((await servedColumnsOf(p.id, planning.id))[0].category).toBe("TODO");
    // The same in the board list, where both kinds come together.
    const listed = (await (await listBoards(req("GET"), { params: Promise.resolve({ orgId, projectId: p.id }) })).json()) as { id: string; columns: { key: string; category: string }[] }[];
    expect(listed.find((b) => b.id === planning.id)!.columns[0].category).toBe("TODO");
    expect(listed.find((b) => b.id === kanban.id)!.columns.find((c) => c.key === "doing")?.category).toBe("DONE");
  });

  it("does not reset a category when a spec gives none", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    await prisma.$transaction((tx) =>
      ensureStatuses(tx, { orgId, projectId: p.id }, [{ key: "done", name: "Done" }], { writeCategory: true }),
    );
    expect((await statusesOf(p.id)).find((s) => s.key === "done")?.category).toBe("DONE");
  });
});

describe("archived statuses", () => {
  it("are not restored, nor recategorised, by a spec that does not ask to restore them", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    await prisma.workflowStatus.update({ where: { projectId_key: { projectId: p.id, key: "doing" } }, data: { archivedAt: new Date() } });
    await prisma.$transaction((tx) =>
      ensureStatuses(tx, { orgId, projectId: p.id }, [{ key: "doing", name: "Doing" }]),
    );
    expect((await statusesOf(p.id)).find((s) => s.key === "doing")).toMatchObject({ archived: true, category: "IN_PROGRESS" });
  });

  it("a new board's column without a category leaves the status's category as it is", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    await board(p.id, "TABLE", [{ key: "done", name: "Done" }]);
    expect((await statusesOf(p.id)).find((s) => s.key === "done")?.category).toBe("DONE");
  });

  it("a new board's column without a category restores a status with the category it had", async () => {
    const p = await project();
    await prisma.workflowStatus.create({
      data: { orgId, projectId: p.id, key: "shipped", name: "Shipped", category: "DONE", sortOrder: 5, archivedAt: new Date() },
    });
    await board(p.id, "TABLE", [{ key: "shipped", name: "Shipped" }]);
    expect((await statusesOf(p.id)).find((s) => s.key === "shipped")).toMatchObject({ archived: false, category: "DONE" });
  });

  it("come back when a new board's column names them, with the column's category", async () => {
    const p = await project();
    // As the backfill leaves an orphan key: archived, with a guessed category.
    await prisma.workflowStatus.create({
      data: { orgId, projectId: p.id, key: "todo", name: "todo", category: "DONE", sortOrder: 1000, archivedAt: new Date() },
    });
    const kanban = await board(p.id, "KANBAN");
    expect((await statusesOf(p.id)).find((s) => s.key === "todo")).toMatchObject({ category: "TODO", archived: false });
    expect((await columnsOf(kanban.id)).find((c) => c.key === "todo")?.category).toBe("TODO");
  });

  it("stay archived when only their category is edited", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    await prisma.workflowStatus.update({ where: { projectId_key: { projectId: p.id, key: "doing" } }, data: { archivedAt: new Date() } });
    const res = await patchStatus(
      req("PATCH", { category: "DONE" }),
      { params: Promise.resolve({ orgId, projectId: p.id, key: "doing" }) },
    );
    expect(await res.json()).toMatchObject({ category: "DONE", archived: true });
  });
});

describe("renameStatusIfUnshared", () => {
  it("renames the status when no other board shows it, and its items follow", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const wi = await item(p.id, "doing");
    const col = await prisma.boardColumn.findFirstOrThrow({ where: { boardId: kanban.id, key: "doing" } });
    const renamed = await prisma.$transaction((tx) =>
      renameStatusIfUnshared(tx, { projectId: p.id, from: "doing", to: "wip", columnId: col.id }),
    );
    expect(renamed).toBe(true);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: wi.id } })).columnKey).toBe("wip");
  });

  it("leaves the status alone when another board still shows it, or the new key is taken", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    await board(p.id, "TABLE", [{ key: "doing", name: "Doing" }]);
    const col = await prisma.boardColumn.findFirstOrThrow({ where: { boardId: kanban.id, key: "doing" } });
    expect(
      await prisma.$transaction((tx) => renameStatusIfUnshared(tx, { projectId: p.id, from: "doing", to: "wip", columnId: col.id })),
    ).toBe(false);
    // "done" is already a status: this column now shows Done, nothing is renamed.
    const p2 = await project();
    const k2 = await board(p2.id, "KANBAN");
    const todo2 = await prisma.boardColumn.findFirstOrThrow({ where: { boardId: k2.id, key: "todo" } });
    expect(
      await prisma.$transaction((tx) => renameStatusIfUnshared(tx, { projectId: p2.id, from: "todo", to: "done", columnId: todo2.id })),
    ).toBe(false);
    expect((await statusesOf(p2.id)).map((s) => s.key)).toEqual(["todo", "doing", "done"]);
  });
});

describe("ensureCancelledStatus", () => {
  const run = (projectId: string, preferred?: string) =>
    prisma.$transaction((tx) => ensureCancelledStatus(tx, projectId, preferred));

  it("reuses the project's Cancelled status, preferring the one asked for", async () => {
    const p = await project();
    await board(p.id, "KANBAN", [
      ...COLS,
      { key: "abandoned", name: "Abandoned", category: "CANCELLED" },
      { key: "wont-do", name: "Won't do", category: "CANCELLED" },
    ]);
    expect(await run(p.id)).toBe("abandoned");
    expect(await run(p.id, "wont-do")).toBe("wont-do");
    // ...but never a status that isn't a Cancelled one.
    expect(await run(p.id, "done")).toBe("abandoned");
  });

  it("adds the status, and a column at the end of each status board, when there is none", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const review = await board(p.id, "SPRINT_REVIEW", [{ key: "went-well", name: "Went well" }]);
    const empty = await prisma.board.create({ data: { orgId, projectId: p.id, name: "Timeline", type: "TIMELINE" } });

    expect(await run(p.id)).toBe("cancelled");
    expect((await statusesOf(p.id)).at(-1)).toEqual({ key: "cancelled", name: "Cancelled", category: "CANCELLED", archived: false });
    expect((await columnsOf(kanban.id)).at(-1)).toEqual({ key: "cancelled", name: "Cancelled", category: "CANCELLED" });
    expect((await columnsOf(review.id)).map((c) => c.key)).toEqual(["went-well"]);
    expect(await columnsOf(empty.id)).toEqual([]);
    // A second call finds it.
    expect(await run(p.id)).toBe("cancelled");
    expect((await columnsOf(kanban.id)).filter((c) => c.key === "cancelled")).toHaveLength(1);
  });

  it("picks a fresh key when 'cancelled' is already a status meaning something else", async () => {
    const p = await project();
    await board(p.id, "KANBAN", [
      { key: "cancelled", name: "Called off", category: "TODO" },
      { key: "cancelled-2", name: "Also", category: "TODO" },
    ]);
    expect(await run(p.id)).toBe("cancelled-3");
  });
});

describe("statuses API", () => {
  const ps = (projectId: string) => ({ params: Promise.resolve({ orgId, projectId }) });
  const pk = (projectId: string, key: string) => ({ params: Promise.resolve({ orgId, projectId, key }) });

  it("lists statuses in order, with item counts and archived ones when asked", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    await item(p.id, "doing");
    await prisma.workflowStatus.update({ where: { projectId_key: { projectId: p.id, key: "todo" } }, data: { archivedAt: new Date() } });

    const plain = await (await listStatuses(req("GET"), ps(p.id))).json();
    expect(plain.map((s: { key: string }) => s.key)).toEqual(["doing", "done"]);
    expect(plain[0]).not.toHaveProperty("items");

    const full = await (await listStatuses(req("GET", undefined, "?archived=true&counts=true"), ps(p.id))).json();
    expect(full.map((s: { key: string; items: number; archived: boolean }) => [s.key, s.items, s.archived])).toEqual([
      ["todo", 0, true],
      ["doing", 1, false],
      ["done", 0, false],
    ]);
  });

  it("needs workflow-manage to create one once the project runs a custom workflow", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    const wf = await prisma.workflow.create({ data: { orgId, projectId: p.id, name: "Custom", createdById: userId } });
    await prisma.workflowAssignment.create({ data: { orgId, projectId: p.id, workflowId: wf.id } });
    const saved = calls.ctx;
    calls.ctx = { ...(saved as AuthContext), orgRole: OrgRole.MEMBER, permissions: (saved as AuthContext).permissions & ~Permission.WORKFLOW_MANAGE };
    try {
      const res = await createStatus(req("POST", { key: "qa", name: "QA", category: "IN_PROGRESS" }), { params: Promise.resolve({ orgId, projectId: p.id }) });
      expect(res.status).toBe(403);
    } finally {
      calls.ctx = saved;
    }
  });

  it("creates a status, and refuses a duplicate key", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    const res = await createStatus(req("POST", { key: "blocked", name: "Blocked", category: "IN_PROGRESS" }), ps(p.id));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ key: "blocked", name: "Blocked", category: "IN_PROGRESS", archived: false, sortOrder: 3 });
    expect(calls.audit.at(-1)).toMatchObject({ action: "workflow.status_created" });
    expect((await createStatus(req("POST", { key: "blocked", name: "Again", category: "TODO" }), ps(p.id))).status).toBe(409);
  });

  it("changes a status's category, which every column showing it then reports", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const res = await patchStatus(req("PATCH", { category: "DONE", name: "Shipping" }), pk(p.id, "doing"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: "doing", name: "Shipping", category: "DONE" });
    expect((await servedColumnsOf(p.id, kanban.id)).find((c) => c.key === "doing")?.category).toBe("DONE");
    // No copy kept in step any more: the column's own row is left as it was.
    expect((await columnsOf(kanban.id)).find((c) => c.key === "doing")?.category).toBe("IN_PROGRESS");
    expect(calls.audit.at(-1)).toMatchObject({
      action: "workflow.status_updated",
      metadata: expect.objectContaining({ categoryFrom: "IN_PROGRESS", categoryTo: "DONE" }),
    });
  });

  it("archives and restores a status", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    expect(await (await patchStatus(req("PATCH", { archived: true }), pk(p.id, "todo"))).json()).toMatchObject({ archived: true });
    expect(await (await patchStatus(req("PATCH", { archived: false }), pk(p.id, "todo"))).json()).toMatchObject({ archived: false });
  });

  it("refuses to delete a status with items in it, and otherwise removes it and its columns", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const wi = await item(p.id, "doing");

    const refused = await deleteStatus(req("DELETE"), pk(p.id, "doing"));
    expect(refused.status).toBe(409);
    expect((await refused.json()).detail).toMatch(/1 item is in this status/);

    await prisma.workItem.update({ where: { id: wi.id }, data: { columnKey: "todo" } });
    expect((await deleteStatus(req("DELETE"), pk(p.id, "doing"))).status).toBe(204);
    expect((await statusesOf(p.id)).map((s) => s.key)).toEqual(["todo", "done"]);
    expect((await columnsOf(kanban.id)).map((c) => c.key)).toEqual(["todo", "done"]);
  });

  it("answers 404 for a status the project does not have", async () => {
    const p = await project();
    expect((await patchStatus(req("PATCH", { name: "x" }), pk(p.id, "nope"))).status).toBe(404);
  });
});

describe("board column editor", () => {
  const pb = (projectId: string, boardId: string) => ({ params: Promise.resolve({ orgId, projectId, boardId }) });

  it("renames a status by editing its only column's key, and its items follow", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const wi = await item(p.id, "doing");
    const cols = await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, orderBy: { sortOrder: "asc" } });
    const res = await putColumns(
      req("PUT", {
        columns: cols.map((c) => ({
          id: c.id, name: c.key === "doing" ? "In flight" : c.name, key: c.key === "doing" ? "in-flight" : c.key,
          sortOrder: c.sortOrder, category: c.category,
        })),
      }),
      pb(p.id, kanban.id),
    );
    expect(res.status).toBe(200);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: wi.id } })).columnKey).toBe("in-flight");
    expect((await statusesOf(p.id)).map((s) => s.key)).toEqual(["todo", "in-flight", "done"]);
  });

  it("adds a column's status, and keeps the status of a removed column", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const wi = await item(p.id, "doing");
    const cols = await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, orderBy: { sortOrder: "asc" } });
    const keep = cols.filter((c) => c.key !== "doing");
    const res = await putColumns(
      req("PUT", {
        columns: [
          ...keep.map((c) => ({ id: c.id, name: c.name, key: c.key, sortOrder: c.sortOrder, category: c.category })),
          { name: "QA", key: "qa", sortOrder: 9, category: "IN_PROGRESS" },
        ],
      }),
      pb(p.id, kanban.id),
    );
    expect(res.status).toBe(200);
    const statuses = await statusesOf(p.id);
    expect(statuses.find((s) => s.key === "qa")).toMatchObject({ name: "QA", category: "IN_PROGRESS" });
    expect((await columnsOf(kanban.id)).find((c) => c.key === "qa")?.category).toBe("IN_PROGRESS");
    // The column went; the status and the item in it stay.
    expect(statuses.find((s) => s.key === "doing")).toBeTruthy();
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: wi.id } })).columnKey).toBe("doing");
  });

  it("refuses a new category on a column: the category is its status's, set in the workflow editor", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const cols = await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, orderBy: { sortOrder: "asc" } });
    const res = await putColumns(
      req("PUT", { columns: cols.map((c) => ({ id: c.id, name: c.name, key: c.key, sortOrder: c.sortOrder, category: c.key === "todo" ? "DONE" : c.category })) }),
      pb(p.id, kanban.id),
    );
    expect(res.status).toBe(409);
    expect((await statusesOf(p.id)).find((s) => s.key === "todo")?.category).toBe("TODO");
  });

  it("needs workflow-manage to add a status once the project runs a custom workflow", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const wf = await prisma.workflow.create({ data: { orgId, projectId: p.id, name: "Custom", createdById: userId } });
    await prisma.workflowAssignment.create({ data: { orgId, projectId: p.id, workflowId: wf.id } });
    const cols = await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, orderBy: { sortOrder: "asc" } });
    const body = {
      columns: [
        ...cols.map((c) => ({ id: c.id, name: c.name, key: c.key, sortOrder: c.sortOrder })),
        { name: "QA", key: "qa", sortOrder: 9, category: "IN_PROGRESS" },
      ],
    };
    const saved = calls.ctx;
    // Board rights, but no workflow rights and no project role.
    calls.ctx = { ...(saved as AuthContext), orgRole: OrgRole.MEMBER, permissions: (saved as AuthContext).permissions & ~Permission.WORKFLOW_MANAGE };
    try {
      expect((await putColumns(req("PUT", body), pb(p.id, kanban.id))).status).toBe(403);
      expect((await statusesOf(p.id)).find((s) => s.key === "qa")).toBeUndefined();
      // Reordering what is already there needs no more than before.
      const reorder = { columns: [...cols].reverse().map((c, i) => ({ id: c.id, name: c.name, key: c.key, sortOrder: i })) };
      expect((await putColumns(req("PUT", reorder), pb(p.id, kanban.id))).status).toBe(200);
    } finally {
      calls.ctx = saved;
    }
    expect((await putColumns(req("PUT", body), pb(p.id, kanban.id))).status).toBe(200);
  });

  // Every save sends every column, so a save must not undo what was decided
  // about a status elsewhere.
  const save = (projectId: string, boardId: string, columns: unknown[]) =>
    putColumns(req("PUT", { columns }), pb(projectId, boardId));
  const archive = (projectId: string, key: string) =>
    prisma.workflowStatus.update({ where: { projectId_key: { projectId, key } }, data: { archivedAt: new Date() } });

  it("keeps an archived status archived when the board's columns are reordered or renamed", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    await archive(p.id, "doing");
    const cols = await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, orderBy: { sortOrder: "asc" } });
    const res = await save(p.id, kanban.id, [...cols].reverse().map((c, i) => ({
      id: c.id, name: c.key === "todo" ? "Backlog" : c.name, key: c.key, sortOrder: i, category: c.category,
    })));
    expect(res.status).toBe(200);
    expect((await statusesOf(p.id)).find((s) => s.key === "doing")).toMatchObject({ archived: true, category: "IN_PROGRESS" });
  });

  it("keeps a conflicted board's DONE lane DONE through an unrelated reorder", async () => {
    const p = await project();
    await board(p.id, "KANBAN");
    // As the backfill leaves a conflict: the status says IN_PROGRESS (the first
    // board's), this board's lane says DONE.
    const scrum = await board(p.id, "SCRUM", [
      { key: "todo", name: "To Do", category: "TODO" },
      { key: "doing", name: "Shipped", category: "IN_PROGRESS" },
    ]);
    await prisma.boardColumn.updateMany({ where: { boardId: scrum.id, key: "doing" }, data: { category: "DONE" } });
    const cols = await prisma.boardColumn.findMany({ where: { boardId: scrum.id }, orderBy: { sortOrder: "asc" } });
    const res = await save(p.id, scrum.id, [...cols].reverse().map((c, i) => ({
      id: c.id, name: c.name, key: c.key, sortOrder: i, category: c.category,
    })));
    expect(res.status).toBe(200);
    expect((await columnsOf(scrum.id)).find((c) => c.key === "doing")?.category).toBe("DONE");
    expect((await statusesOf(p.id)).find((s) => s.key === "doing")?.category).toBe("IN_PROGRESS");
  });

  it("leaves an existing status's category alone when a save gives none", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const table = await board(p.id, "TABLE", [{ key: "todo", name: "To Do", category: "TODO" }]);
    const cols = await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, orderBy: { sortOrder: "asc" } });
    // The board's columns sent back without categories.
    expect((await save(p.id, kanban.id, cols.map((c) => ({ id: c.id, name: c.name, key: c.key, sortOrder: c.sortOrder })))).status).toBe(200);
    // Another board starts showing "done", without a category.
    const [todo] = await prisma.boardColumn.findMany({ where: { boardId: table.id } });
    expect((await save(p.id, table.id, [
      { id: todo.id, name: todo.name, key: todo.key, sortOrder: 0 },
      { name: "Shipped", key: "done", sortOrder: 1 },
    ])).status).toBe(200);
    expect((await statusesOf(p.id)).find((s) => s.key === "done")?.category).toBe("DONE");
    expect((await columnsOf(table.id)).find((c) => c.key === "done")?.category).toBe("DONE");
  });

  it("restores an archived status when a column is re-keyed to show it", async () => {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    await prisma.workflowStatus.create({
      data: { orgId, projectId: p.id, key: "qa", name: "qa", category: "TODO", sortOrder: 1000, archivedAt: new Date() },
    });
    const cols = await prisma.boardColumn.findMany({ where: { boardId: kanban.id }, orderBy: { sortOrder: "asc" } });
    const res = await save(p.id, kanban.id, cols.map((c) => ({
      id: c.id, name: c.key === "doing" ? "QA" : c.name, key: c.key === "doing" ? "qa" : c.key,
      sortOrder: c.sortOrder, category: c.key === "doing" ? "IN_PROGRESS" : c.category,
    })));
    expect(res.status).toBe(200);
    expect((await statusesOf(p.id)).find((s) => s.key === "qa")).toMatchObject({ archived: false, category: "IN_PROGRESS" });
  });
});

describe("lanes the backfill found disagreeing", () => {
  /** A Scrum board whose Doing lane is DONE while the status is IN_PROGRESS, as the backfill left it. */
  async function conflicted() {
    const p = await project();
    const kanban = await board(p.id, "KANBAN");
    const scrum = await board(p.id, "SCRUM", [{ key: "doing", name: "Shipped", category: "IN_PROGRESS" }]);
    await prisma.boardColumn.updateMany({ where: { boardId: scrum.id, key: "doing" }, data: { category: "DONE" } });
    const status = await prisma.workflowStatus.findUniqueOrThrow({ where: { projectId_key: { projectId: p.id, key: "doing" } } });
    await prisma.auditLog.create({
      data: { orgId, action: "workflow.backfill_conflict", entity: "workflow_status", entityId: status.id, metadata: { key: "doing", chosenCategory: "IN_PROGRESS" } },
    });
    return { p, kanban, scrum };
  }
  const pp = (projectId: string) => ({ params: Promise.resolve({ orgId, projectId }) });
  const lane = async (projectId: string, boardId: string) => (await servedColumnsOf(projectId, boardId)).find((c) => c.key === "doing")?.category;

  it("keep their own category until resolved, then follow their status", async () => {
    const { p, kanban, scrum } = await conflicted();
    expect(await lane(p.id, scrum.id)).toBe("DONE");
    expect(await lane(p.id, kanban.id)).toBe("IN_PROGRESS");

    const listed = await (await listConflicts(req("GET"), pp(p.id))).json();
    expect(listed).toEqual([expect.objectContaining({ key: "doing", statusCategory: "IN_PROGRESS", boards: [expect.objectContaining({ boardId: scrum.id, category: "DONE" })] })]);

    const res = await resolveConflict(req("POST", { key: "doing", take: "status" }), pp(p.id));
    expect(await res.json()).toEqual({ category: "IN_PROGRESS" });
    expect(await lane(p.id, scrum.id)).toBe("IN_PROGRESS");
    expect(await (await listConflicts(req("GET"), pp(p.id))).json()).toEqual([]);
  });

  it("can be resolved with the board's category, which the status then takes", async () => {
    const { p, kanban, scrum } = await conflicted();
    await resolveConflict(req("POST", { key: "doing", take: "DONE" }), pp(p.id));
    expect((await statusesOf(p.id)).find((s) => s.key === "doing")?.category).toBe("DONE");
    expect(await lane(p.id, kanban.id)).toBe("DONE");
    expect(await lane(p.id, scrum.id)).toBe("DONE");
  });

  it("are left alone by a change to the status's category before they are resolved", async () => {
    const { p, kanban, scrum } = await conflicted();
    await patchStatus(req("PATCH", { category: "TODO" }), { params: Promise.resolve({ orgId, projectId: p.id, key: "doing" }) });
    expect(await lane(p.id, kanban.id)).toBe("TODO");
    expect(await lane(p.id, scrum.id)).toBe("DONE");
  });
});
