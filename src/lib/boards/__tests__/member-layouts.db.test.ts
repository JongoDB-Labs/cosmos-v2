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
