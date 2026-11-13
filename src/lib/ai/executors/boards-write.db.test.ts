// @vitest-environment node
//
// The assistant's board tools against the board REST routes, for the SAME real
// actor, in a real database (e2e DB). Each case runs the route handler (only
// `getAuthContext` is mocked, to hand it the actor's own AuthContext) and the
// tool, and asserts they agree: both allow, or both refuse and nothing is
// written. A tool that drifts from the route in either direction fails here.
//
// Every refusal has a positive control beside it (the same tool, a different
// actor or board, succeeding), so a refusal cannot pass because the tool is
// simply broken.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import type { ToolContext } from "./_ctx";
import { createBoardTool, deleteBoardTool, getBoardTool, setBoardColumns, updateBoardTool } from "./boards";
import { POST as createRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/route";
import { PUT as columnsRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/columns/route";

type Out = { error?: string; created?: boolean; updated?: boolean; deleted?: boolean; board?: { id: string } };

let orgId: string;
let managed: string; // bob MANAGES it
let other: string; // nobody manages it
let owner: ToolContext; // OWNER
let manager: ToolContext; // MEMBER + project MANAGER of `managed`
let member: ToolContext; // plain MEMBER
let viewerInProject: ToolContext; // MEMBER, project VIEWER of `managed`
let boardEditor: ToolContext; // MEMBER holding org-wide BOARD_UPDATE + BOARD_DELETE, on no team
const extraUsers: string[] = [];

/** Run a route handler as this actor. */
async function asRest(actor: ToolContext, handler: (r: NextRequest, c: never) => Promise<Response>, params: Record<string, string>, method: string, body?: unknown) {
  getAuthContext.mockResolvedValue(actor.auth as AuthContext);
  const res = await handler(
    new NextRequest("http://localhost/x", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve({ orgId, ...params }) } as never,
  );
  return res.status;
}

const allowed = (status: number) => status >= 200 && status < 300;

async function newUser(tag: string) {
  const u = await prisma.user.create({ data: { email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, displayName: tag } });
  extraUsers.push(u.id);
  return u;
}

async function board(projectId: string, name: string, teamId: string | null = null) {
  return prisma.board.create({ data: { orgId, projectId, name, type: "KANBAN", sortOrder: 0, teamId, config: { keep: "me" } } });
}

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
  const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
  const carol = await prisma.user.findFirstOrThrow({ where: { email: "carol@test.local" } });
  const org = await prisma.organization.create({ data: { name: `board tools ${stamp}`, slug: `board-tools-${stamp}` } });
  orgId = org.id;

  await prisma.orgMember.create({ data: { orgId, userId: alice.id, role: "OWNER" } });
  const bobM = await prisma.orgMember.create({ data: { orgId, userId: bob.id, role: "MEMBER" } });
  await prisma.orgMember.create({ data: { orgId, userId: carol.id, role: "MEMBER" } });
  const pv = await newUser("project-viewer");
  const pvM = await prisma.orgMember.create({ data: { orgId, userId: pv.id, role: "MEMBER" } });
  const ed = await newUser("board-editor");
  await prisma.orgMember.create({
    data: { orgId, userId: ed.id, role: "MEMBER", permissions: maskToDb(Permission.BOARD_UPDATE | Permission.BOARD_DELETE) },
  });

  const k = stamp.slice(-4).toUpperCase();
  managed = (await prisma.project.create({ data: { orgId, name: "Managed", key: `BTA${k}` } })).id;
  other = (await prisma.project.create({ data: { orgId, name: "Other", key: `BTB${k}` } })).id;
  await prisma.projectMember.create({ data: { projectId: managed, orgMemberId: bobM.id, role: "MANAGER" } });
  await prisma.projectMember.create({ data: { projectId: managed, orgMemberId: pvM.id, role: "VIEWER" } });

  owner = await memberToolCtx(orgId, alice.id);
  manager = await memberToolCtx(orgId, bob.id);
  member = await memberToolCtx(orgId, carol.id);
  viewerInProject = await memberToolCtx(orgId, pv.id);
  boardEditor = await memberToolCtx(orgId, ed.id);
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  if (extraUsers.length) await prisma.user.deleteMany({ where: { id: { in: extraUsers } } }).catch(() => undefined);
});

describe("board tools match the board routes (e2e DB)", () => {
  it("the fixture is what it claims", () => {
    const has = (c: ToolContext, bit: bigint) => (c.auth!.permissions & bit) === bit;
    expect(has(member, Permission.BOARD_CREATE)).toBe(true);
    expect(has(member, Permission.BOARD_UPDATE)).toBe(false);
    expect(has(manager, Permission.BOARD_UPDATE)).toBe(false);
    expect(has(boardEditor, Permission.BOARD_UPDATE)).toBe(true);
    expect(has(boardEditor, Permission.PROJECT_MANAGE)).toBe(false);
  });

  describe("create_board", () => {
    it("a member may create a board, through the route and the tool alike", async () => {
      const rest = await asRest(member, createRoute, { projectId: other }, "POST", { name: "Via REST" });
      const tool = (await createBoardTool({ projectId: other, name: "Via tool" }, member)) as Out;
      expect(allowed(rest)).toBe(true);
      expect(tool.error).toBeUndefined();
      expect(tool.created).toBe(true);
      // A Kanban board is seeded with the project's workflow, as the route does.
      expect(await prisma.boardColumn.count({ where: { boardId: tool.board!.id } })).toBeGreaterThan(0);
    });

    it("a project VIEWER is refused by both, even holding the org-wide bit", async () => {
      const rest = await asRest(viewerInProject, createRoute, { projectId: managed }, "POST", { name: "Nope REST" });
      const tool = (await createBoardTool({ projectId: managed, name: "Nope tool" }, viewerInProject)) as Out;
      expect(rest).toBe(403);
      expect(tool.error).toMatch(/permission/i);
      expect(await prisma.board.count({ where: { projectId: managed, name: { startsWith: "Nope" } } })).toBe(0);
    });

    it("honours the project's disabled board types, as the route does", async () => {
      await prisma.project.update({ where: { id: other }, data: { settings: { disabledBoardTypes: ["TABLE"] } } });
      try {
        const rest = await asRest(member, createRoute, { projectId: other }, "POST", { name: "T", type: "TABLE" });
        const tool = (await createBoardTool({ projectId: other, name: "T", type: "TABLE" }, member)) as Out;
        expect(rest).toBe(403);
        expect(tool.error).toMatch(/disabled/i);
        // Positive control: another type in the same project is fine.
        const ok = (await createBoardTool({ projectId: other, name: "K", type: "KANBAN" }, member)) as Out;
        expect(ok.created).toBe(true);
      } finally {
        await prisma.project.update({ where: { id: other }, data: { settings: {} } });
      }
    });

    it("saves a query as the board's baseline, the same shape Save as board writes", async () => {
      const tool = (await createBoardTool(
        { projectId: other, name: "High ones", cql: `project = "${(await prisma.project.findUniqueOrThrow({ where: { id: other } })).key}" AND priority = High` },
        member,
      )) as Out & { baseline?: string };
      expect(tool.error).toBeUndefined();
      const row = await prisma.board.findUniqueOrThrow({ where: { id: tool.board!.id } });
      const config = row.config as { query?: { where: { op: string } }; savedFilter?: { priorities?: string[] } };
      // The project clause is dropped (the board pins its own project) and the
      // rest is stored; the legacy filter rides along because it can say it.
      expect(config.query?.where.op).toBe("cmp");
      expect(JSON.stringify(config.query)).not.toContain('"project"');
      expect(config.savedFilter?.priorities).toEqual(["HIGH"]);
    });

    it("refuses a query on a board type that cannot show one, and writes nothing", async () => {
      const before = await prisma.board.count({ where: { projectId: other } });
      const tool = (await createBoardTool({ projectId: other, name: "Plan", type: "SPRINT_PLANNING", cql: "priority = High" }, member)) as Out;
      expect(tool.error).toMatch(/cannot show a query/);
      expect(await prisma.board.count({ where: { projectId: other } })).toBe(before);
    });

    it("an assistant limited to other projects cannot create here, and neither can a key so scoped", async () => {
      const scoped: ToolContext = { ...member, auth: { ...member.auth!, projectScope: [managed] } };
      const rest = await asRest(scoped, createRoute, { projectId: other }, "POST", { name: "Scoped REST" });
      const tool = (await createBoardTool({ projectId: other, name: "Scoped tool" }, scoped)) as Out;
      expect(allowed(rest)).toBe(false);
      expect(tool.error).toBe("Project not found");
      expect(await prisma.board.count({ where: { projectId: other, name: { startsWith: "Scoped" } } })).toBe(0);
    });
  });

  describe("update_board / set_board_columns / delete_board", () => {
    it("a plain member is refused by the routes and the tools, and nothing changes", async () => {
      const b = await board(managed, "Untouched");
      const restPut = await asRest(member, updateRoute, { projectId: managed, boardId: b.id }, "PUT", { name: "X" });
      const restDel = await asRest(member, deleteRoute, { projectId: managed, boardId: b.id }, "DELETE");
      const restCols = await asRest(member, columnsRoute, { projectId: managed, boardId: b.id }, "PUT", { columns: [] });
      const up = (await updateBoardTool({ projectId: managed, boardId: b.id, name: "X" }, member)) as Out;
      const del = (await deleteBoardTool({ projectId: managed, boardId: b.id }, member)) as Out;
      const cols = (await setBoardColumns({ projectId: managed, boardId: b.id, columns: [{ name: "A", key: "a" }] }, member)) as Out;
      expect([restPut, restDel, restCols]).toEqual([403, 403, 403]);
      expect(up.error).toMatch(/permission/i);
      expect(del.error).toMatch(/permission/i);
      expect(cols.error).toMatch(/permission/i);
      expect(await prisma.board.findUnique({ where: { id: b.id } })).toMatchObject({ name: "Untouched" });
    });

    it("the project's MANAGER may, through both", async () => {
      const b = await board(managed, "Mine");
      expect(await asRest(manager, updateRoute, { projectId: managed, boardId: b.id }, "PUT", { name: "Mine (REST)" })).toBe(200);
      const up = (await updateBoardTool({ projectId: managed, boardId: b.id, name: "Mine (tool)" }, manager)) as Out;
      expect(up.updated).toBe(true);
      const row = await prisma.board.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.name).toBe("Mine (tool)");
      // A rename leaves the rest of the config alone.
      expect(row.config).toEqual({ keep: "me" });

      const cols = (await setBoardColumns(
        { projectId: managed, boardId: b.id, columns: [{ name: "Ideas", key: "ideas", category: "TODO" }, { name: "Done", key: "done", category: "DONE" }] },
        manager,
      )) as Out & { columns?: { key: string }[] };
      expect(cols.error).toBeUndefined();
      expect(cols.columns?.map((c) => c.key)).toEqual(["ideas", "done"]);

      const del = (await deleteBoardTool({ projectId: managed, boardId: b.id }, manager)) as Out;
      expect(del.deleted).toBe(true);
      expect(await prisma.board.findUnique({ where: { id: b.id } })).toBeNull();
    });

    it("changing the query keeps the board's other settings and can clear the baseline", async () => {
      const b = await board(managed, "Queried");
      const set = (await updateBoardTool({ projectId: managed, boardId: b.id, cql: "priority = Low" }, manager)) as Out;
      expect(set.error).toBeUndefined();
      let config = (await prisma.board.findUniqueOrThrow({ where: { id: b.id } })).config as Record<string, unknown>;
      expect(config.keep).toBe("me");
      expect(config.query).toBeDefined();
      const cleared = (await updateBoardTool({ projectId: managed, boardId: b.id, cql: "" }, manager)) as Out;
      expect(cleared.error).toBeUndefined();
      config = (await prisma.board.findUniqueOrThrow({ where: { id: b.id } })).config as Record<string, unknown>;
      expect(config).toEqual({ keep: "me" });
    });

    it("an assistant limited to other projects cannot change this one's boards, and neither can such a key", async () => {
      const b = await board(managed, "Scoped");
      const scoped: ToolContext = { ...manager, auth: { ...manager.auth!, projectScope: [other] } };
      const rest = await asRest(scoped, updateRoute, { projectId: managed, boardId: b.id }, "PUT", { name: "Changed" });
      const tool = (await updateBoardTool({ projectId: managed, boardId: b.id, name: "Changed" }, scoped)) as Out;
      expect(allowed(rest)).toBe(false);
      expect(tool.error).toBeDefined();
      expect((await prisma.board.findUniqueOrThrow({ where: { id: b.id } })).name).toBe("Scoped");
    });

    // The actor the old inline route gate let through: `hasPermission(BOARD_UPDATE)`
    // was its first branch, and it asked neither the project's visibility nor the
    // caller's project ceiling, so an org-wide holder limited to OTHER projects
    // still changed this one's boards.
    it("an org-wide BOARD_UPDATE/BOARD_DELETE holder limited to other projects is refused on both doors", async () => {
      const b = await board(managed, "Ceiling");
      const scoped: ToolContext = { ...boardEditor, auth: { ...boardEditor.auth!, projectScope: [other] } };
      const restPut = await asRest(scoped, updateRoute, { projectId: managed, boardId: b.id }, "PUT", { name: "Changed" });
      const toolPut = (await updateBoardTool({ projectId: managed, boardId: b.id, name: "Changed" }, scoped)) as Out;
      const restDel = await asRest(scoped, deleteRoute, { projectId: managed, boardId: b.id }, "DELETE");
      const toolDel = (await deleteBoardTool({ projectId: managed, boardId: b.id }, scoped)) as Out;
      expect(allowed(restPut)).toBe(false);
      expect(toolPut.error).toBeDefined();
      expect(allowed(restDel)).toBe(false);
      expect(toolDel.error).toBeDefined();
      expect((await prisma.board.findUniqueOrThrow({ where: { id: b.id } })).name).toBe("Ceiling");
    });

    it("positive control: the same holder, unscoped, changes that board through both", async () => {
      const b = await board(managed, "Ceiling open");
      expect(await asRest(boardEditor, updateRoute, { projectId: managed, boardId: b.id }, "PUT", { name: "Open (REST)" })).toBe(200);
      const tool = (await updateBoardTool({ projectId: managed, boardId: b.id, name: "Open (tool)" }, boardEditor)) as Out;
      expect(tool.updated).toBe(true);
      expect((await prisma.board.findUniqueOrThrow({ where: { id: b.id } })).name).toBe("Open (tool)");
    });
  });

  describe("a board on a team the caller is not on is not there, for writes as for reads", () => {
    let teamBoard: { id: string };
    let openBoard: { id: string };
    beforeAll(async () => {
      const team = await prisma.team.create({ data: { orgId, projectId: other, name: "Team A" } });
      teamBoard = await board(other, "Team board", team.id);
      openBoard = await board(other, "Open board");
    });

    it("an org-wide BOARD_UPDATE holder outside the team gets NotFound on update, through the route and the tool", async () => {
      const rest = await asRest(boardEditor, updateRoute, { projectId: other, boardId: teamBoard.id }, "PUT", { name: "Hijacked" });
      const tool = (await updateBoardTool({ projectId: other, boardId: teamBoard.id, name: "Hijacked" }, boardEditor)) as Out;
      expect(rest).toBe(404);
      expect(tool.error).toBe("Board not found");
      expect((await prisma.board.findUniqueOrThrow({ where: { id: teamBoard.id } })).name).toBe("Team board");
    });

    it("…and NotFound on delete, through both", async () => {
      const rest = await asRest(boardEditor, deleteRoute, { projectId: other, boardId: teamBoard.id }, "DELETE");
      const tool = (await deleteBoardTool({ projectId: other, boardId: teamBoard.id }, boardEditor)) as Out;
      expect(rest).toBe(404);
      expect(tool.error).toBe("Board not found");
      expect(await prisma.board.findUnique({ where: { id: teamBoard.id } })).not.toBeNull();
    });

    it("positive control: the same actor CAN change a board shared with the whole project", async () => {
      expect(await asRest(boardEditor, updateRoute, { projectId: other, boardId: openBoard.id }, "PUT", { name: "Open (REST)" })).toBe(200);
      const tool = (await updateBoardTool({ projectId: other, boardId: openBoard.id, name: "Open (tool)" }, boardEditor)) as Out;
      expect(tool.updated).toBe(true);
    });

    it("get_board hides it too, and shows it to the owner", async () => {
      expect(((await getBoardTool({ projectId: other, boardId: teamBoard.id }, boardEditor)) as Out).error).toBe("Board not found");
      const seen = (await getBoardTool({ projectId: other, boardId: teamBoard.id }, owner)) as Out;
      expect(seen.error).toBeUndefined();
      expect(seen.board?.id).toBe(teamBoard.id);
    });
  });

  // The old route gate's first branch, `hasPermission(BOARD_UPDATE)`, asked
  // nothing about the project, so an org-wide holder changed and deleted the
  // boards of a team-scoped project they were not on.
  describe("a board on a project the caller cannot see is refused, for writes as for reads", () => {
    let closed: string;
    let closedBoard: { id: string };
    beforeAll(async () => {
      const k = Math.random().toString(36).slice(2, 6).toUpperCase();
      closed = (await prisma.project.create({ data: { orgId, name: "Closed", key: `BTC${k}`, teamScopedAccess: true } })).id;
      closedBoard = await board(closed, "Closed board");
    });

    it("an org-wide BOARD_UPDATE/BOARD_DELETE holder is refused update and delete through both, and the board is untouched", async () => {
      const at = { projectId: closed, boardId: closedBoard.id };
      const restPut = await asRest(boardEditor, updateRoute, at, "PUT", { name: "Hijacked" });
      const toolPut = (await updateBoardTool({ ...at, name: "Hijacked" }, boardEditor)) as Out;
      const restDel = await asRest(boardEditor, deleteRoute, at, "DELETE");
      const toolDel = (await deleteBoardTool(at, boardEditor)) as Out;
      expect(allowed(restPut)).toBe(false);
      expect(toolPut.error).toBeDefined();
      expect(allowed(restDel)).toBe(false);
      expect(toolDel.error).toBeDefined();
      expect((await prisma.board.findUniqueOrThrow({ where: { id: closedBoard.id } })).name).toBe("Closed board");
    });

    it("positive control: the same holder, once on the project, renames it through both", async () => {
      const om = await prisma.orgMember.findFirstOrThrow({ where: { orgId, userId: boardEditor.userId } });
      await prisma.projectMember.create({ data: { projectId: closed, orgMemberId: om.id, role: "VIEWER" } });
      const at = { projectId: closed, boardId: closedBoard.id };
      expect(await asRest(boardEditor, updateRoute, at, "PUT", { name: "Seen (REST)" })).toBe(200);
      const tool = (await updateBoardTool({ ...at, name: "Seen (tool)" }, boardEditor)) as Out;
      expect(tool.updated).toBe(true);
      expect((await prisma.board.findUniqueOrThrow({ where: { id: closedBoard.id } })).name).toBe("Seen (tool)");
    });
  });
});

// A board's creator may rename it, lay it out and delete it without managing
// the project, on a board that draws saved widgets (`canManageOwnBoard`). That
// rule lives in the board service, so the tools get it from the same place as
// the routes; these cases prove the tools did not keep a stricter or looser
// gate of their own. The route-side edges (a creator who lost the create gate,
// the team axis, manager-only config keys) are driven in
// lib/boards/__tests__/member-layouts.db.test.ts against the same service.
describe("a board's creator, through the tools and the routes (e2e DB)", () => {
  let other2: ToolContext; // a plain member of the org who did not make the board

  beforeAll(() => {
    // pv holds a project VIEWER role on `managed` only; on `other` they are a
    // plain member like carol, which is all these cases need.
    other2 = viewerInProject;
  });

  async function ownDashboard(name: string, cql?: string) {
    const made = (await createBoardTool({ projectId: other, name, type: "DASHBOARD", ...(cql ? { cql } : {}) }, member)) as Out;
    expect(made.error, name).toBeUndefined();
    return made.board!.id;
  }

  it("create_board makes the caller the board's owner, as the route does, and neither reply names the owner", async () => {
    const tool = (await createBoardTool({ projectId: other, name: "Owned (tool)", type: "DASHBOARD" }, member)) as Out;
    getAuthContext.mockResolvedValue(member.auth as AuthContext);
    const res = await createRoute(
      new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ name: "Owned (REST)", type: "DASHBOARD" }) }),
      { params: Promise.resolve({ orgId, projectId: other }) } as never,
    );
    expect(res.status).toBe(201);
    const restBody = (await res.json()) as { id: string; ownedByMe?: boolean };
    const rows = await prisma.board.findMany({ where: { id: { in: [tool.board!.id, restBody.id] } }, select: { ownerId: true } });
    expect(rows.map((r) => r.ownerId)).toEqual([member.userId, member.userId]);
    expect(JSON.stringify(tool)).not.toContain("ownerId");
    expect(restBody).not.toHaveProperty("ownerId");
    expect(restBody.ownedByMe).toBe(true);
  });

  it("the creator may rename their dashboard through the tool and the route; another member may not", async () => {
    const id = await ownDashboard("Standup");
    const up = (await updateBoardTool({ projectId: other, boardId: id, name: "Standup (tool)" }, member)) as Out;
    expect(up.error).toBeUndefined();
    expect(up.updated).toBe(true);
    expect(await asRest(member, updateRoute, { projectId: other, boardId: id }, "PUT", { name: "Standup (REST)" })).toBe(200);

    const theirs = (await updateBoardTool({ projectId: other, boardId: id, name: "Taken" }, other2)) as Out;
    expect(theirs.error).toMatch(/permission/i);
    expect(await asRest(other2, updateRoute, { projectId: other, boardId: id }, "PUT", { name: "Taken" })).toBe(403);
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).name).toBe("Standup (REST)");
  });

  it("the creator's query change is refused through the tool, not silently dropped (positive control: a board manager's goes through)", async () => {
    const id = await ownDashboard("Mine queried", "priority = High");
    const before = (await prisma.board.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>;
    expect(before.query).toBeDefined();

    const up = (await updateBoardTool({ projectId: other, boardId: id, cql: "priority = Low" }, member)) as Out;
    expect(up.updated).toBeUndefined();
    expect(up.error).toMatch(/manager/i);
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).config).toEqual(before);

    const managed2 = (await updateBoardTool({ projectId: other, boardId: id, cql: "priority = Low" }, boardEditor)) as Out;
    expect(managed2.error).toBeUndefined();
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).config).not.toEqual(before);
  });

  it("the creator may delete their dashboard through the tool; another member may not", async () => {
    const id = await ownDashboard("Scratch");
    expect(((await deleteBoardTool({ projectId: other, boardId: id }, other2)) as Out).error).toMatch(/permission/i);
    expect(await prisma.board.findUnique({ where: { id } })).not.toBeNull();
    const del = (await deleteBoardTool({ projectId: other, boardId: id }, member)) as Out;
    expect(del.error).toBeUndefined();
    expect(del.deleted).toBe(true);
    expect(await prisma.board.findUnique({ where: { id } })).toBeNull();
  });

  it("the creator may not delete their dashboard once a ceremony hangs off it, through either door (positive control: a board manager may)", async () => {
    const id = await ownDashboard("With ceremony");
    const interval = await prisma.interval.create({
      data: { orgId, projectId: other, number: 900 + Math.floor(Math.random() * 99), name: "S", startDate: new Date(), endDate: new Date() },
    });
    await prisma.sprintCeremony.create({ data: { orgId, boardId: id, intervalId: interval.id, kind: "REVIEW" } });

    const tool = (await deleteBoardTool({ projectId: other, boardId: id }, member)) as Out;
    expect(tool.error).toMatch(/ceremony/i);
    expect(await asRest(member, deleteRoute, { projectId: other, boardId: id }, "DELETE")).toBe(403);
    expect(await prisma.board.findUnique({ where: { id } })).not.toBeNull();

    const byManager = (await deleteBoardTool({ projectId: other, boardId: id }, boardEditor)) as Out;
    expect(byManager.deleted).toBe(true);
  });

  it("owner rights cover widget boards only: the creator of a Kanban board is refused on both doors", async () => {
    const made = (await createBoardTool({ projectId: other, name: "My kanban", type: "KANBAN" }, member)) as Out;
    const id = made.board!.id;
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).ownerId).toBe(member.userId);
    expect(((await updateBoardTool({ projectId: other, boardId: id, name: "x" }, member)) as Out).error).toMatch(/permission/i);
    expect(await asRest(member, updateRoute, { projectId: other, boardId: id }, "PUT", { name: "x" })).toBe(403);
    expect(((await deleteBoardTool({ projectId: other, boardId: id }, member)) as Out).error).toMatch(/permission/i);
    expect(await prisma.board.findUnique({ where: { id } })).not.toBeNull();
  });

  it("the owner path needs board read on the project: a creator a policy now denies it is refused on both doors (positive control: without the deny)", async () => {
    const id = await ownDashboard("Denied owner");
    const denied: ToolContext = {
      ...member,
      auth: {
        ...member.auth!,
        abacRules: [{ effect: "deny", actions: ["BOARD_READ"], conditions: [{ attr: "projectId", op: "eq", value: other }] }],
      } as AuthContext,
    };
    // The REST door reaches the service's own owner-path check: nothing in
    // front of it asks about board read.
    expect(allowed(await asRest(denied, updateRoute, { projectId: other, boardId: id }, "PUT", { name: "x" }))).toBe(false);
    expect(allowed(await asRest(denied, deleteRoute, { projectId: other, boardId: id }, "DELETE"))).toBe(false);
    expect(((await updateBoardTool({ projectId: other, boardId: id, name: "x" }, denied)) as Out).error).toBeDefined();
    expect(((await deleteBoardTool({ projectId: other, boardId: id }, denied)) as Out).error).toBeDefined();
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).name).toBe("Denied owner");

    expect(await asRest(member, updateRoute, { projectId: other, boardId: id }, "PUT", { name: "Allowed owner" })).toBe(200);
    expect(await asRest(member, deleteRoute, { projectId: other, boardId: id }, "DELETE")).toBe(204);
  });

  it("an assistant limited to other projects cannot use the owner path either", async () => {
    const id = await ownDashboard("Scoped owner");
    const scoped: ToolContext = { ...member, auth: { ...member.auth!, projectScope: [managed] } };
    expect(((await updateBoardTool({ projectId: other, boardId: id, name: "x" }, scoped)) as Out).error).toBeDefined();
    expect(((await deleteBoardTool({ projectId: other, boardId: id }, scoped)) as Out).error).toBeDefined();
    const row = await prisma.board.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe("Scoped owner");
  });
});
