// @vitest-environment node
//
// (e2e DB) Who may change a dashboard's layout, against the real routes.
//
// A MEMBER holds BOARD_CREATE and not BOARD_UPDATE. Before boards had an owner,
// a member could create a dashboard and then save no change to it. Now:
//   * the person who made a board may rename it and change its layout;
//   * nobody else without board-management rights may change it for others;
//   * anyone who can see a dashboard may keep their OWN arrangement of it,
//     which changes nothing for anyone else.
//
// Every refusal below is paired with a positive control on the same route, so
// a 403 is the rule talking and not a route that refuses everything.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import { seedWorld, type World } from "@/lib/query/__tests__/cql-fixture";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/rate-limit/guard", () => ({ checkRateLimit: () => null }));

import { POST as createBoard } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import {
  PUT as putBoard,
  DELETE as deleteBoard,
} from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/route";
import {
  GET as getMine,
  PUT as putMine,
  DELETE as deleteMine,
} from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/my-layout/route";
import { GET as listBoards } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/route";
import { GET as getBoard } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/route";
import { GET as getProject } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/route";
import { GET as getCeremony } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/route";

let w: World;
let as: AuthContext;

/** The fixture's actor, with a plain MEMBER's org permissions. */
const member = (): AuthContext => ({
  ...w.ctx({ denyP3: true }),
  permissions: RolePermissions.MEMBER,
  basePermissions: RolePermissions.MEMBER,
});
/** Someone else on the same project, also a plain member. */
const otherMember = (): AuthContext => ({ ...member(), userId: w.bob.id });
/** An org admin: holds BOARD_UPDATE / BOARD_DELETE. */
const admin = (): AuthContext => ({
  ...member(),
  permissions: RolePermissions.ADMIN,
  basePermissions: RolePermissions.ADMIN,
});

const url = (projectId: string, tail = "") =>
  `http://localhost/api/v1/orgs/${w.orgA}/projects/${projectId}/boards${tail}`;
const json = (method: string, href: string, body?: unknown) =>
  new NextRequest(href, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
const boardParams = (projectId: string, boardId: string) => ({
  params: Promise.resolve({ orgId: w.orgA, projectId, boardId }),
});

const WIDGETS = [
  { id: "w1", type: "counter", config: { metric: "overdue" }, layout: { x: 0, y: 0, w: 3, h: 2 } },
];
const MY_WIDGETS = [
  { id: "m1", type: "deadline-list", config: {}, layout: { x: 0, y: 0, w: 6, h: 6 } },
];

const configOf = async (id: string) =>
  ((await prisma.board.findUniqueOrThrow({ where: { id } })).config ?? {}) as Record<string, unknown>;

let shared: string; // a dashboard nobody here made
let mine: string; // the actor's own dashboard, made through the route

beforeAll(async () => {
  w = await seedWorld();
  getAuthContext.mockImplementation(async () => as);
  shared = (
    await prisma.board.create({
      data: {
        orgId: w.orgA,
        projectId: w.P1.id,
        name: "Team health",
        type: "DASHBOARD",
        config: { widgets: WIDGETS, query: "priority = HIGH" },
      },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await w?.cleanup();
});

describe("a member's own dashboard", () => {
  it("is owned by whoever created it", async () => {
    as = member();
    const res = await createBoard(json("POST", url(w.P1.id), { name: "My standup", type: "DASHBOARD" }), {
      params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id }),
    });
    expect(res.status).toBe(201);
    mine = ((await res.json()) as { id: string }).id;
    const row = await prisma.board.findUniqueOrThrow({ where: { id: mine } });
    expect(row.ownerId).toBe(w.actor.id);
  });

  it("can be re-laid-out and renamed by its creator", async () => {
    as = member();
    const res = await putBoard(
      json("PUT", url(w.P1.id, `/${mine}`), { name: "Standup", config: { widgets: WIDGETS } }),
      boardParams(w.P1.id, mine),
    );
    expect(res.status).toBe(200);
    const row = await prisma.board.findUniqueOrThrow({ where: { id: mine } });
    expect(row.name).toBe("Standup");
    expect((row.config as { widgets: unknown[] }).widgets).toEqual(WIDGETS);
  });

  it("cannot be re-laid-out by another member", async () => {
    as = otherMember();
    const res = await putBoard(
      json("PUT", url(w.P1.id, `/${mine}`), { config: { widgets: [] } }),
      boardParams(w.P1.id, mine),
    );
    expect(res.status).toBe(403);
    expect((await configOf(mine)).widgets).toEqual(WIDGETS);
  });

  it("does not let its creator do a manager's job: team, type and order stay gated", async () => {
    as = member();
    for (const body of [{ teamId: w.teamP1 }, { type: "KANBAN" }, { sortOrder: 9 }]) {
      const res = await putBoard(json("PUT", url(w.P1.id, `/${mine}`), body), boardParams(w.P1.id, mine));
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    const row = await prisma.board.findUniqueOrThrow({ where: { id: mine } });
    expect(row.teamId).toBeNull();
    expect(row.type).toBe("DASHBOARD");
  });

  it("stops being theirs to change once they cannot see the project", async () => {
    // A board the actor made on P2, a team-scoped project they are not on.
    const hidden = await prisma.board.create({
      data: { orgId: w.orgA, projectId: w.P2.id, name: "Old", type: "DASHBOARD", ownerId: w.actor.id },
    });
    as = member();
    const res = await putBoard(
      json("PUT", url(w.P2.id, `/${hidden.id}`), { config: { widgets: [] } }),
      boardParams(w.P2.id, hidden.id),
    );
    expect([403, 404]).toContain(res.status);
    expect((await prisma.board.findUniqueOrThrow({ where: { id: hidden.id } })).config).toEqual({});
  });

  it("can be deleted by its creator, and not by another member", async () => {
    as = member();
    const extra = (
      await (
        await createBoard(json("POST", url(w.P1.id), { name: "Scratch", type: "DASHBOARD" }), {
          params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id }),
        })
      ).json()
    ) as { id: string };
    as = otherMember();
    expect((await deleteBoard(json("DELETE", url(w.P1.id, `/${extra.id}`)), boardParams(w.P1.id, extra.id))).status).toBe(403);
    expect(await prisma.board.findUnique({ where: { id: extra.id } })).not.toBeNull();
    as = member();
    expect((await deleteBoard(json("DELETE", url(w.P1.id, `/${extra.id}`)), boardParams(w.P1.id, extra.id))).status).toBe(204);
    expect(await prisma.board.findUnique({ where: { id: extra.id } })).toBeNull();
  });
});

describe("a shared dashboard", () => {
  it("cannot be re-laid-out by a member who did not make it", async () => {
    as = member();
    const res = await putBoard(
      json("PUT", url(w.P1.id, `/${shared}`), { config: { widgets: MY_WIDGETS } }),
      boardParams(w.P1.id, shared),
    );
    expect(res.status).toBe(403);
    expect((await configOf(shared)).widgets).toEqual(WIDGETS);
  });

  it("can be re-laid-out by someone who manages boards (positive control)", async () => {
    as = admin();
    const res = await putBoard(
      json("PUT", url(w.P1.id, `/${shared}`), {
        config: { widgets: WIDGETS, query: "priority = HIGH", note: "admin" },
      }),
      boardParams(w.P1.id, shared),
    );
    expect(res.status).toBe(200);
    expect((await configOf(shared)).note).toBe("admin");
  });
});

describe("my own layout of a shared dashboard", () => {
  const mineUrl = (projectId: string, boardId: string) => url(projectId, `/${boardId}/my-layout`);

  it("is saved for me, and changes nothing anyone else sees", async () => {
    const before = await configOf(shared);
    as = member();
    const put = await putMine(json("PUT", mineUrl(w.P1.id, shared), { widgets: MY_WIDGETS }), boardParams(w.P1.id, shared));
    expect(put.status).toBe(200);

    const got = await getMine(json("GET", mineUrl(w.P1.id, shared)), boardParams(w.P1.id, shared));
    expect(got.status).toBe(200);
    expect(((await got.json()) as { layout: { widgets: unknown } }).layout.widgets).toEqual(MY_WIDGETS);

    // The shared layout is untouched…
    expect(await configOf(shared)).toEqual(before);
    // …and someone else on the project still gets no personal layout.
    as = otherMember();
    const theirs = await getMine(json("GET", mineUrl(w.P1.id, shared)), boardParams(w.P1.id, shared));
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as { layout: unknown }).layout).toBeNull();
  });

  it("can be dropped to go back to the shared layout", async () => {
    as = member();
    const del = await deleteMine(json("DELETE", mineUrl(w.P1.id, shared)), boardParams(w.P1.id, shared));
    expect(del.status).toBe(204);
    const got = await getMine(json("GET", mineUrl(w.P1.id, shared)), boardParams(w.P1.id, shared));
    expect(((await got.json()) as { layout: unknown }).layout).toBeNull();
  });

  it("is refused on a dashboard I cannot see", async () => {
    const p2Board = await prisma.board.create({
      data: { orgId: w.orgA, projectId: w.P2.id, name: "Hidden", type: "DASHBOARD" },
    });
    const p3Board = await prisma.board.create({
      data: { orgId: w.orgA, projectId: w.P3.id, name: "Denied", type: "DASHBOARD" },
    });
    // P2: a team-scoped project the actor is not on. P3: the actor is on the
    // project, but an org policy denies them its boards.
    const cases = [
      { label: "P2 team-scoped", projectId: w.P2.id, boardId: p2Board.id, ctx: member() },
      {
        label: "P3 board-read denied",
        projectId: w.P3.id,
        boardId: p3Board.id,
        ctx: {
          ...member(),
          abacRules: [
            {
              effect: "deny",
              actions: ["BOARD_READ"],
              conditions: [{ attr: "projectId", op: "eq", value: w.P3.id }],
            },
          ],
        } as AuthContext,
      },
    ];
    for (const c of cases) {
      as = c.ctx;
      const res = await putMine(json("PUT", mineUrl(c.projectId, c.boardId), { widgets: MY_WIDGETS }), boardParams(c.projectId, c.boardId));
      expect([403, 404], c.label).toContain(res.status);
      const got = await getMine(json("GET", mineUrl(c.projectId, c.boardId)), boardParams(c.projectId, c.boardId));
      expect([403, 404], `${c.label} GET`).toContain(got.status);
    }
    expect(await prisma.personalBoardLayout.count({ where: { boardId: { in: [p2Board.id, p3Board.id] } } })).toBe(0);

    // Positive control: the same P3 board with no deny accepts a layout, so the
    // refusal above is the policy and not the board.
    as = member();
    const ok = await putMine(json("PUT", mineUrl(w.P3.id, p3Board.id), { widgets: MY_WIDGETS }), boardParams(w.P3.id, p3Board.id));
    expect(ok.status).toBe(200);
  });

  it("is refused on a board that draws no widgets", async () => {
    const kanban = await prisma.board.findFirstOrThrow({ where: { projectId: w.P1.id, type: "KANBAN" } });
    as = member();
    const res = await putMine(json("PUT", mineUrl(w.P1.id, kanban.id), { widgets: MY_WIDGETS }), boardParams(w.P1.id, kanban.id));
    expect(res.status).toBe(400);
  });

  it("refuses a malformed layout", async () => {
    as = member();
    const bad = [{ id: "x", type: "counter", config: {}, layout: { x: 0, y: 0, w: 0, h: 2 } }];
    const res = await putMine(json("PUT", mineUrl(w.P1.id, shared), { widgets: bad }), boardParams(w.P1.id, shared));
    expect(res.status).toBe(400);
  });
});

// ── The owner path, probed at its edges ──────────────────────────────────────
//
// Each case below is a regression an independent review could make without a
// test failing (its mutations M2, M5, M6, M8, M10, M11), or a reach the owner
// path had that its rationale never meant to give (ceremony boards, project-wide
// config flags). Every refusal has a manager or same-route positive control.

/** Create a board through the route as the actor (so the actor owns it). */
async function ownBoard(type: string, name: string, config?: Record<string, unknown>): Promise<string> {
  as = member();
  const res = await createBoard(
    json("POST", url(w.P1.id), { name: `${name} ${Math.random().toString(36).slice(2, 7)}`, type, ...(config ? { config } : {}) }),
    { params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id }) },
  );
  expect(res.status, `create ${type}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
const put = (ctx: AuthContext, id: string, body: unknown, projectId = w.P1.id) => {
  as = ctx;
  return putBoard(json("PUT", url(projectId, `/${id}`), body), boardParams(projectId, id));
};
const del = (ctx: AuthContext, id: string, projectId = w.P1.id) => {
  as = ctx;
  return deleteBoard(json("DELETE", url(projectId, `/${id}`)), boardParams(projectId, id));
};
const orgViewer = (): AuthContext =>
  ({ ...member(), orgRole: "VIEWER", permissions: RolePermissions.VIEWER, basePermissions: RolePermissions.VIEWER }) as AuthContext;

describe("the owner path ends where the create gate ends", () => {
  it("refuses a creator who is now an org VIEWER, on PUT and DELETE (positive control: the same board as a member)", async () => {
    const id = await ownBoard("DASHBOARD", "Lapsed org");
    expect((await put(orgViewer(), id, { name: "x" })).status).toBe(403);
    expect((await del(orgViewer(), id)).status).toBe(403);
    expect(await prisma.board.findUnique({ where: { id } })).not.toBeNull();
    expect((await put(member(), id, { name: "still mine" })).status).toBe(200);
  });

  it("refuses a creator who is now a project VIEWER, on PUT and DELETE", async () => {
    const id = await ownBoard("DASHBOARD", "Lapsed project");
    const om = await prisma.orgMember.findFirstOrThrow({ where: { orgId: w.orgA, userId: w.actor.id } });
    await prisma.projectMember.updateMany({ where: { projectId: w.P1.id, orgMemberId: om.id }, data: { role: "VIEWER" } });
    try {
      expect((await put(member(), id, { name: "x" })).status).toBe(403);
      expect((await del(member(), id)).status).toBe(403);
    } finally {
      await prisma.projectMember.updateMany({ where: { projectId: w.P1.id, orgMemberId: om.id }, data: { role: "MEMBER" } });
    }
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).name).not.toBe("x");
    expect((await put(member(), id, { name: "back" })).status).toBe(200);
  });

  it("refuses DELETE on a board the creator can no longer see the project of", async () => {
    const hidden = await prisma.board.create({
      data: { orgId: w.orgA, projectId: w.P2.id, name: "Old", type: "DASHBOARD", ownerId: w.actor.id },
    });
    expect([403, 404]).toContain((await del(member(), hidden.id, w.P2.id)).status);
    expect(await prisma.board.findUnique({ where: { id: hidden.id } })).not.toBeNull();
  });
});

describe("the owner path and the team axis", () => {
  let myTeam: string;
  beforeAll(async () => {
    const pm = await prisma.projectMember.findFirstOrThrow({
      where: { projectId: w.P1.id, orgMember: { userId: w.actor.id } },
    });
    myTeam = (await prisma.team.create({ data: { orgId: w.orgA, projectId: w.P1.id, name: "Mine" } })).id;
    await prisma.teamMember.create({ data: { teamId: myTeam, projectMemberId: pm.id } });
  });

  it("lets a creator change and personalise their board on a team they are on (positive control)", async () => {
    const id = await ownBoard("DASHBOARD", "On my team");
    await prisma.board.update({ where: { id }, data: { teamId: myTeam } });
    expect((await put(member(), id, { config: { widgets: WIDGETS } })).status).toBe(200);
    as = member();
    const mineRes = await putMine(json("PUT", url(w.P1.id, `/${id}/my-layout`), { widgets: MY_WIDGETS }), boardParams(w.P1.id, id));
    expect(mineRes.status).toBe(200);
  });

  it("refuses PUT, DELETE and my-layout on the creator's board once it is on a team they are not on", async () => {
    const id = await ownBoard("DASHBOARD", "Off my team");
    await prisma.board.update({ where: { id }, data: { teamId: w.teamP1 } }); // bob's team, not the actor's
    expect([403, 404]).toContain((await put(member(), id, { name: "x", config: { widgets: [] } })).status);
    expect([403, 404]).toContain((await del(member(), id)).status);
    as = member();
    const mineRes = await putMine(json("PUT", url(w.P1.id, `/${id}/my-layout`), { widgets: MY_WIDGETS }), boardParams(w.P1.id, id));
    expect([403, 404]).toContain(mineRes.status);
    const mineGet = await getMine(json("GET", url(w.P1.id, `/${id}/my-layout`)), boardParams(w.P1.id, id));
    expect([403, 404]).toContain(mineGet.status);
    const row = await prisma.board.findUniqueOrThrow({ where: { id } });
    expect(row.name).not.toBe("x");
    expect(await prisma.personalBoardLayout.count({ where: { boardId: id } })).toBe(0);
  });

  it("refuses a creator sending teamId: null, which would un-scope their board for everyone", async () => {
    const id = await ownBoard("DASHBOARD", "Scoped");
    await prisma.board.update({ where: { id }, data: { teamId: myTeam } });
    const res = await put(member(), id, { teamId: null });
    expect(res.status).toBe(403);
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).teamId).toBe(myTeam);
    // Positive control: a manager may share it with the whole project again.
    expect((await put(admin(), id, { teamId: null })).status).toBe(200);
    expect((await prisma.board.findUniqueOrThrow({ where: { id } })).teamId).toBeNull();
  });
});

describe("my-layout DELETE", () => {
  it("drops only the caller's own arrangement", async () => {
    const id = await ownBoard("DASHBOARD", "Two layouts");
    as = member();
    expect((await putMine(json("PUT", url(w.P1.id, `/${id}/my-layout`), { widgets: MY_WIDGETS }), boardParams(w.P1.id, id))).status).toBe(200);
    as = otherMember();
    expect((await putMine(json("PUT", url(w.P1.id, `/${id}/my-layout`), { widgets: MY_WIDGETS }), boardParams(w.P1.id, id))).status).toBe(200);
    as = member();
    expect((await deleteMine(json("DELETE", url(w.P1.id, `/${id}/my-layout`)), boardParams(w.P1.id, id))).status).toBe(204);
    const left = await prisma.personalBoardLayout.findMany({ where: { boardId: id }, select: { userId: true } });
    expect(left).toEqual([{ userId: w.bob.id }]);
  });
});

describe("owner rights reach the layout of a widget board, and nothing else", () => {
  const readCeremony = async (boardId: string) => {
    as = member();
    const res = await getCeremony(
      new NextRequest(
        `http://localhost/api/v1/orgs/${w.orgA}/projects/${w.P1.id}/intervals/${w.sprintP1Done}/ceremony?boardId=${boardId}`,
      ),
      { params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id, intervalId: w.sprintP1Done }) },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { ceremony: { notes: Array<{ authorId: string | null }> } }).ceremony.notes;
  };
  const withNote = async (boardId: string) => {
    const c = await prisma.sprintCeremony.create({
      data: { orgId: w.orgA, boardId, intervalId: w.sprintP1Done, kind: "REVIEW" },
    });
    await prisma.retroNote.create({ data: { ceremonyId: c.id, columnKey: "stop", text: "a colleague's note", authorId: w.bob.id } });
    return c.id;
  };

  it("does not let the creator of a review board reveal who wrote its notes (positive control: a manager may)", async () => {
    const id = await ownBoard("SPRINT_REVIEW", "Review");
    await withNote(id);
    expect((await readCeremony(id))[0].authorId).toBeNull();
    const res = await put(member(), id, { config: { showNoteAuthors: true } });
    expect(res.status).toBe(403);
    expect((await readCeremony(id))[0].authorId).toBeNull();
    expect((await put(admin(), id, { config: { showNoteAuthors: true } })).status).toBe(200);
    expect((await readCeremony(id))[0].authorId).toBe(w.bob.id);
  });

  it("does not let the creator of a review board delete it with other people's notes (positive control: a manager may)", async () => {
    const id = await ownBoard("SPRINT_REVIEW", "Review del");
    const ceremonyId = await withNote(id);
    expect((await del(member(), id)).status).toBe(403);
    expect(await prisma.retroNote.count({ where: { ceremonyId } })).toBe(1);
    expect((await del(admin(), id)).status).toBe(204);
    expect(await prisma.board.findUnique({ where: { id } })).toBeNull();
  });

  it("does not let the creator delete their dashboard once a ceremony hangs off it (positive control: a manager may)", async () => {
    const id = await ownBoard("DASHBOARD", "With ceremony");
    const ceremonyId = await withNote(id);
    const res = await del(member(), id);
    expect(res.status).toBe(403);
    expect(await prisma.retroNote.count({ where: { ceremonyId } })).toBe(1);
    expect((await del(admin(), id)).status).toBe(204);
  });

  it("does not let the creator of a Kanban board set the project-wide WIP flag (positive control: a manager may)", async () => {
    const id = await ownBoard("KANBAN", "Flow");
    expect((await put(member(), id, { config: { wipHardEnforce: true } })).status).toBe(403);
    expect((await configOf(id)).wipHardEnforce).toBeUndefined();
    expect((await put(admin(), id, { config: { wipHardEnforce: true } })).status).toBe(200);
    expect((await configOf(id)).wipHardEnforce).toBe(true);
  });

  it("changes only the widgets on the creator's own dashboard; manager-only keys keep their stored values", async () => {
    const id = await ownBoard("DASHBOARD", "Keys", { widgets: [], query: "priority = HIGH", classification: "LOW" });
    const sent = {
      widgets: WIDGETS,
      query: "",
      classification: "HIGH",
      showNoteAuthors: true,
      wipHardEnforce: true,
    };
    expect((await put(member(), id, { config: sent })).status).toBe(200);
    expect(await configOf(id)).toEqual({ widgets: WIDGETS, query: "priority = HIGH", classification: "LOW" });
    // Positive control: a manager's PUT writes the config it sends.
    expect((await put(admin(), id, { config: sent })).status).toBe(200);
    expect(await configOf(id)).toEqual(sent);
  });
});

describe("who made a board reaches readers only as ownedByMe", () => {
  it("is never sent as an id, on the board list, the board, the project or the create response", async () => {
    as = member();
    const created = await createBoard(json("POST", url(w.P1.id), { name: `Owned ${Math.random()}`, type: "DASHBOARD" }), {
      params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id }),
    });
    const createdBody = (await created.json()) as Record<string, unknown>;
    const id = createdBody.id as string;
    expect(createdBody.ownedByMe).toBe(true);
    expect(createdBody).not.toHaveProperty("ownerId");

    const read = async (ctx: AuthContext) => {
      as = ctx;
      const list = (await (await listBoards(json("GET", url(w.P1.id)), { params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id }) })).json()) as Array<Record<string, unknown>>;
      as = ctx;
      const one = (await (await getBoard(json("GET", url(w.P1.id, `/${id}`)), boardParams(w.P1.id, id))).json()) as Record<string, unknown>;
      as = ctx;
      const project = (await (
        await getProject(json("GET", `http://localhost/api/v1/orgs/${w.orgA}/projects/${w.P1.id}`), {
          params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id }),
        })
      ).json()) as { boards: Array<Record<string, unknown>> };
      return [list.find((b) => b.id === id)!, one, project.boards.find((b) => b.id === id)!];
    };
    for (const row of await read(otherMember())) {
      expect(row).not.toHaveProperty("ownerId");
      expect(row.ownedByMe).toBe(false);
    }
    for (const row of await read(member())) {
      expect(row).not.toHaveProperty("ownerId");
      expect(row.ownedByMe).toBe(true);
    }
  });
});
