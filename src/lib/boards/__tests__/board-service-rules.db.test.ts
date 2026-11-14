// @vitest-environment node
//
// The board service is the one rule both doors use: the board REST routes and
// the assistant's board tools. Three things it owes them, driven through the
// real routes (only `getAuthContext` is mocked, to hand each route the actor's
// own AuthContext) and the real tools, against a real database:
//
//   - a board in a project the caller cannot see is the same 404 as a board
//     that does not exist, on every surface that names a board by id;
//   - the app's board list and the assistant's list_boards are one list: the
//     same boards for the same person, read through the service's listBoards;
//   - the assistant says whether the caller made a board (`ownedByMe`), as the
//     app does, through the same `boardForReader`, never with the owner's id,
//     and that flag survives the structural egress projection.
//
// Every refusal has a positive control beside it, so a refusal cannot pass
// because the surface is simply broken.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext, getCurrentUser: async () => null }));

import { prisma } from "@/lib/db/client";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import type { ToolContext } from "@/lib/ai/executors/_ctx";
import { getBoardTool, listBoards as listBoardsTool } from "@/lib/ai/executors/boards";
import { entityTypeForTool, projectResult } from "@/lib/ai/egress/projection";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PUT as updateRoute,
} from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/route";
import { PUT as columnsRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/columns/route";

type ListedBoard = { id: string; ownedByMe?: boolean; [k: string]: unknown };
type ToolList = { error?: string; count?: number; boards?: ListedBoard[] };
type ToolGet = { error?: string; board?: ListedBoard };

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MADE_UP = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const users: string[] = [];
let orgId = "";
let open = ""; // shared with the whole org
let closed = ""; // team-scoped; only `owner` (org OWNER) sees it
let maker: ToolContext; // MEMBER; made `dashboard`
let peer: ToolContext; // MEMBER; made nothing
let editor: ToolContext; // MEMBER holding org-wide BOARD_UPDATE + BOARD_DELETE, on no team
let owner: ToolContext; // org OWNER
let dashboard = ""; // in `open`, made by `maker`
let shared = ""; // in `open`, made by nobody
let teamBoard = ""; // in `open`, on a team nobody here is on
let closedBoard = ""; // in `closed`

async function call(actor: ToolContext, handler: (r: NextRequest, c: never) => Promise<Response>, params: Record<string, string>, method: string, body?: unknown) {
  getAuthContext.mockResolvedValue(actor.auth as AuthContext);
  return handler(
    new NextRequest("http://localhost/x", {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    }),
    { params: Promise.resolve({ orgId, ...params }) } as never,
  );
}

async function routeList(actor: ToolContext, projectId: string): Promise<ListedBoard[]> {
  const res = await call(actor, listRoute, { projectId }, "GET");
  expect(res.status).toBe(200);
  return (await res.json()) as ListedBoard[];
}

async function toolList(actor: ToolContext, projectId: string): Promise<ListedBoard[]> {
  const out = (await listBoardsTool({ projectId }, actor)) as ToolList;
  expect(out.error).toBeUndefined();
  return out.boards!;
}

const ids = (rows: ListedBoard[]) => rows.map((b) => b.id).sort();

beforeAll(async () => {
  const user = async (tag: string) => {
    const u = await prisma.user.create({ data: { email: `${tag}-${stamp}@board-rules.test`, displayName: tag } });
    users.push(u.id);
    return u.id;
  };
  const [ownerId, makerId, peerId, editorId] = [await user("owner"), await user("maker"), await user("peer"), await user("editor")];
  orgId = (await prisma.organization.create({ data: { name: `board rules ${stamp}`, slug: `board-rules-${stamp}` } })).id;
  await prisma.orgMember.create({ data: { orgId, userId: ownerId, role: "OWNER" } });
  await prisma.orgMember.create({ data: { orgId, userId: makerId, role: "MEMBER" } });
  await prisma.orgMember.create({ data: { orgId, userId: peerId, role: "MEMBER" } });
  await prisma.orgMember.create({
    data: { orgId, userId: editorId, role: "MEMBER", permissions: maskToDb(Permission.BOARD_UPDATE | Permission.BOARD_DELETE) },
  });

  const k = stamp.slice(-4).toUpperCase();
  open = (await prisma.project.create({ data: { orgId, name: "Open", key: `BRO${k}` } })).id;
  closed = (await prisma.project.create({ data: { orgId, name: "Closed", key: `BRC${k}`, teamScopedAccess: true } })).id;
  for (const p of [open, closed]) await ensureFixtureStatuses(p);

  const team = await prisma.team.create({ data: { orgId, projectId: open, name: "Team A" } });
  const board = (projectId: string, name: string, extra: { teamId?: string; ownerId?: string; type?: "KANBAN" | "DASHBOARD" } = {}) =>
    prisma.board.create({ data: { orgId, projectId, name, type: extra.type ?? "KANBAN", teamId: extra.teamId, ownerId: extra.ownerId } });
  dashboard = (await board(open, "Standup", { type: "DASHBOARD", ownerId: makerId })).id;
  shared = (await board(open, "Delivery")).id;
  teamBoard = (await board(open, "Team only", { teamId: team.id })).id;
  closedBoard = (await board(closed, "Closed board")).id;

  [owner, maker, peer, editor] = await Promise.all([ownerId, makerId, peerId, editorId].map((u) => memberToolCtx(orgId, u)));
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
});

describe("the fixture is what it claims", () => {
  it("the editor holds the org-wide board bits, and nobody but the owner sees the closed project", async () => {
    const has = (c: ToolContext, bit: bigint) => (c.auth!.permissions & bit) === bit;
    expect(has(editor, Permission.BOARD_UPDATE | Permission.BOARD_DELETE | Permission.BOARD_READ)).toBe(true);
    expect(has(maker, Permission.BOARD_UPDATE)).toBe(false);
    expect((await call(owner, getRoute, { projectId: closed, boardId: closedBoard }, "GET")).status).toBe(200);
  });
});

describe("a board in a project the caller cannot see is the same 404 as a missing one", () => {
  const surfaces = [
    ["get", getRoute, "GET", undefined],
    ["update", updateRoute, "PUT", { name: "Hijacked" }],
    ["delete", deleteRoute, "DELETE", undefined],
    ["columns", columnsRoute, "PUT", { columns: [] }],
  ] as const;

  for (const [label, handler, method, body] of surfaces) {
    it(`${label}: hidden project, made-up project and made-up board all answer 404`, async () => {
      const hidden = await call(editor, handler, { projectId: closed, boardId: closedBoard }, method, body);
      const noProject = await call(editor, handler, { projectId: MADE_UP, boardId: MADE_UP }, method, body);
      const noBoard = await call(editor, handler, { projectId: open, boardId: MADE_UP }, method, body);
      expect([hidden.status, noProject.status, noBoard.status]).toEqual([404, 404, 404]);
      // The same words too, so the body cannot tell them apart either.
      const detail = async (r: Response) => ((await r.json()) as { error?: string }).error;
      expect(await detail(hidden)).toBe(await detail(noBoard));
    });
  }

  it("and the hidden board is untouched", async () => {
    const row = await prisma.board.findUniqueOrThrow({ where: { id: closedBoard }, select: { name: true } });
    expect(row.name).toBe("Closed board");
  });

  it("positive control: the same editor reads, renames and deletes a board in a project they can see", async () => {
    const spare = (await prisma.board.create({ data: { orgId, projectId: open, name: "Spare", type: "KANBAN" } })).id;
    expect((await call(editor, getRoute, { projectId: open, boardId: spare }, "GET")).status).toBe(200);
    expect((await call(editor, updateRoute, { projectId: open, boardId: spare }, "PUT", { name: "Spare (renamed)" })).status).toBe(200);
    expect((await call(editor, deleteRoute, { projectId: open, boardId: spare }, "DELETE")).status).toBe(204);
    expect(await prisma.board.findUnique({ where: { id: spare } })).toBeNull();
  });

  it("the project's own collection (list, create) still refuses a hidden project as it refuses a missing one", async () => {
    // Addressed to the project, not to a board, so these answer as every other
    // write under a project path does (requireProjectVisible): hidden and missing
    // alike, so neither reveals which it was.
    const statuses = [
      (await call(editor, listRoute, { projectId: closed }, "GET")).status,
      (await call(editor, listRoute, { projectId: MADE_UP }, "GET")).status,
      (await call(maker, createRoute, { projectId: closed }, "POST", { name: "x" })).status,
      (await call(maker, createRoute, { projectId: MADE_UP }, "POST", { name: "x" })).status,
    ];
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(await prisma.board.count({ where: { projectId: closed } })).toBe(1);
  });
});

describe("the app's board list and list_boards are one list", () => {
  it("someone on no team gets the same boards from both, without the team's board", async () => {
    const [rest, tool] = [await routeList(editor, open), await toolList(editor, open)];
    expect(ids(rest)).toEqual([dashboard, shared].sort());
    expect(ids(tool)).toEqual(ids(rest));
  });

  it("positive control: the org owner gets the team's board from both", async () => {
    const [rest, tool] = [await routeList(owner, open), await toolList(owner, open)];
    expect(ids(rest)).toEqual([dashboard, shared, teamBoard].sort());
    expect(ids(tool)).toEqual(ids(rest));
  });

  it("the route's rows keep their shape: columns, counts and the reader's ownedByMe, never ownerId", async () => {
    const [row] = (await routeList(maker, open)).filter((b) => b.id === dashboard);
    expect(row).toMatchObject({ id: dashboard, name: "Standup", type: "DASHBOARD", ownedByMe: true });
    expect(Array.isArray(row.columns)).toBe(true);
    expect(row._count).toEqual(expect.objectContaining({ columns: expect.any(Number) }));
    expect(row).not.toHaveProperty("ownerId");
  });
});

describe("the assistant says whether the caller made a board, as the app does", () => {
  it("list_boards: the maker's dashboard is theirs, the shared board is not, and the route agrees board by board", async () => {
    for (const actor of [maker, peer]) {
      const tool = await toolList(actor, open);
      const rest = await routeList(actor, open);
      const mine = (rows: ListedBoard[]) => Object.fromEntries(rows.map((b) => [b.id, b.ownedByMe]));
      expect(mine(tool)).toEqual(mine(rest));
    }
    const byMaker = Object.fromEntries((await toolList(maker, open)).map((b) => [b.id, b.ownedByMe]));
    const byPeer = Object.fromEntries((await toolList(peer, open)).map((b) => [b.id, b.ownedByMe]));
    expect([byMaker[dashboard], byMaker[shared], byPeer[dashboard], byPeer[shared]]).toEqual([true, false, false, false]);
  });

  it("get_board: true for the maker, false for anyone else", async () => {
    const forMaker = (await getBoardTool({ projectId: open, boardId: dashboard }, maker)) as ToolGet;
    const forPeer = (await getBoardTool({ projectId: open, boardId: dashboard }, peer)) as ToolGet;
    expect(forMaker.error).toBeUndefined();
    expect([forMaker.board?.ownedByMe, forPeer.board?.ownedByMe]).toEqual([true, false]);
  });

  it("neither tool hands anyone the owner's id", async () => {
    const replies = [
      await listBoardsTool({ projectId: open }, peer),
      await getBoardTool({ projectId: open, boardId: dashboard }, peer),
      await listBoardsTool({ projectId: open }, maker),
      await getBoardTool({ projectId: open, boardId: dashboard }, maker),
    ].map((r) => JSON.stringify(r));
    // Positive control: the reply does carry ids (the board's own).
    expect(replies.every((r) => r.includes(dashboard))).toBe(true);
    expect(replies.filter((r) => r.includes("ownerId") || r.includes(maker.userId))).toEqual([]);
  });

  it("the flag survives the structural egress projection, while the board's name does not", async () => {
    const list = projectResult(await listBoardsTool({ projectId: open }, maker), entityTypeForTool("list_boards")) as ToolList;
    const row = list.boards?.find((b) => b.id === dashboard);
    expect(row).toMatchObject({ id: dashboard, ownedByMe: true });
    expect(row).not.toHaveProperty("name");

    const got = projectResult(await getBoardTool({ projectId: open, boardId: dashboard }, maker), entityTypeForTool("get_board")) as ToolGet;
    expect(got.board).toMatchObject({ id: dashboard, ownedByMe: true });
    expect(got.board).not.toHaveProperty("name");
  });
});
