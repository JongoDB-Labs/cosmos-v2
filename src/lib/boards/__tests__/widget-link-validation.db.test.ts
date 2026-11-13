// @vitest-environment node
//
// (e2e DB) Widget link validation on SAVE, against the real routes.
//
// The Link List refuses to draw a link that could leave the app disguised as
// an in-app path (`/\evil.example`, a tab inside the path, `//evil.example`)
// or run script (`javascript:`, `data:`). That is only half a rule if the API
// will STORE one: a direct write would plant it for every viewer, and a later
// renderer change would draw it. So every route that saves widgets runs the
// same check (`widgetLinkProblems`) and answers 400, leaving the stored row
// exactly as it was.
//
// The caller is an org admin throughout, so a 400 here is the link rule and
// never an authorization refusal. Each route has a positive control: an
// in-app path and an external https link both save.
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
import { PUT as putBoard } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/route";
import { PUT as putMine } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/my-layout/route";
import { POST as createWidget } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/dashboard-widgets/route";
import { PUT as putWidget } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/boards/[boardId]/dashboard-widgets/[widgetId]/route";

let w: World;
let board: string;

const admin = (): AuthContext => ({
  ...w.ctx({ denyP3: true }),
  permissions: RolePermissions.ADMIN,
  basePermissions: RolePermissions.ADMIN,
});

const base = () => `http://localhost/api/v1/orgs/${w.orgA}/projects/${w.P1.id}/boards`;
const json = (method: string, href: string, body: unknown) =>
  new NextRequest(href, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const projectParams = () => ({ params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id }) });
const boardParams = () => ({
  params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id, boardId: board }),
});

/** A layout holding one Link List with one link. */
const layoutWith = (target: string) => [
  {
    id: "links",
    type: "link-list",
    config: { title: "Runbooks", links: `Go|${target}` },
    layout: { x: 0, y: 0, w: 4, h: 4 },
  },
];

const HOSTILE = [
  "/\\evil.example",
  "/\t/evil.example",
  "//evil.example",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  // Dot segments: each folds to `//evil.example…` once resolved.
  "/.//evil.example",
  "/a/..//evil.example",
  "/%2e//evil.example",
  "/..//evil.example/x?q#h",
];
const ALLOWED = ["/acme/projects/ACME", "https://evil.example"];

const storedConfig = async () =>
  (await prisma.board.findUniqueOrThrow({ where: { id: board } })).config;
const storedMine = async () =>
  (
    await prisma.personalBoardLayout.findUnique({
      where: { boardId_userId: { boardId: board, userId: w.actor.id } },
    })
  )?.widgets ?? null;

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "";
}

beforeAll(async () => {
  w = await seedWorld();
  getAuthContext.mockImplementation(async () => admin());
  board = (
    await prisma.board.create({
      data: { orgId: w.orgA, projectId: w.P1.id, name: "Links", type: "DASHBOARD", config: {} },
    })
  ).id;
}, 60_000);

afterAll(async () => {
  await w?.cleanup();
});

describe("widget link validation on save", () => {
  it.each(HOSTILE)("board PUT refuses %j with 400 and stores nothing", async (target) => {
    const before = await storedConfig();
    const res = await putBoard(json("PUT", `${base()}/${board}`, { config: { widgets: layoutWith(target) } }), boardParams());
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/"Runbooks", line 1: the link /);
    expect(await storedConfig()).toEqual(before);
  });

  it.each(ALLOWED)("board PUT saves %j (positive control)", async (target) => {
    const res = await putBoard(json("PUT", `${base()}/${board}`, { config: { widgets: layoutWith(target) } }), boardParams());
    expect(res.status).toBe(200);
    expect(await storedConfig()).toEqual({ widgets: layoutWith(target) });
  });

  it.each(HOSTILE)("my-layout PUT refuses %j with 400 and stores nothing", async (target) => {
    const before = await storedMine();
    const res = await putMine(json("PUT", `${base()}/${board}/my-layout`, { widgets: layoutWith(target) }), boardParams());
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/"Runbooks", line 1: the link /);
    expect(await storedMine()).toEqual(before);
  });

  it.each(ALLOWED)("my-layout PUT saves %j (positive control)", async (target) => {
    const res = await putMine(json("PUT", `${base()}/${board}/my-layout`, { widgets: layoutWith(target) }), boardParams());
    expect(res.status).toBe(200);
    expect(await storedMine()).toEqual(layoutWith(target));
  });

  it("a refusal names the first bad line, counts the rest, and lists every one in `issues`", async () => {
    const before = await storedConfig();
    const widgets = [
      { ...layoutWith(HOSTILE[0])[0], config: { title: "Runbooks", links: HOSTILE.map((t, i) => `L${i}|${t}`).join("\n") } },
    ];
    const res = await putBoard(json("PUT", `${base()}/${board}`, { config: { widgets } }), boardParams());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string; issues: { message: string }[] };
    expect(body.error).toBe(
      `A link can't be saved. "Runbooks", line 1: the link contains a backslash, a space or a control character. ${HOSTILE.length - 1} more links have a problem too.`,
    );
    expect(body.issues.map((i) => i.message)).toEqual(HOSTILE.map((_, i) => expect.stringContaining(`"Runbooks", line ${i + 1}: the link `)));
    expect(await storedConfig()).toEqual(before);
  });

  it("board POST refuses a new dashboard carrying a bad link, and creates one with a good link", async () => {
    const count = () => prisma.board.count({ where: { projectId: w.P1.id, name: "Planted" } });
    const bad = await createBoard(
      json("POST", base(), { name: "Planted", type: "DASHBOARD", config: { widgets: layoutWith("/\\evil.example") } }),
      projectParams(),
    );
    expect(bad.status).toBe(400);
    expect(await count()).toBe(0);
    const good = await createBoard(
      json("POST", base(), { name: "Planted", type: "DASHBOARD", config: { widgets: layoutWith("/acme") } }),
      projectParams(),
    );
    expect(good.status).toBe(201);
    expect(await count()).toBe(1);
  });

  it("board POST and the widget API refuse a dot-segment link that resolves off-site", async () => {
    const count = () => prisma.board.count({ where: { projectId: w.P1.id, name: "Dotted" } });
    const bad = await createBoard(
      json("POST", base(), { name: "Dotted", type: "DASHBOARD", config: { widgets: layoutWith("/a/..//evil.example") } }),
      projectParams(),
    );
    expect(bad.status).toBe(400);
    expect(await count()).toBe(0);
    const href = `${base()}/${board}/dashboard-widgets`;
    const before = await prisma.dashboardWidget.count({ where: { boardId: board } });
    const widget = await createWidget(
      json("POST", href, { type: "link-list", config: { links: "Go|/%2e//evil.example" } }),
      boardParams(),
    );
    expect(widget.status).toBe(400);
    expect(await prisma.dashboardWidget.count({ where: { boardId: board } })).toBe(before);
  });

  it("the widget API refuses a bad link on create and on update, and keeps a good one", async () => {
    const href = `${base()}/${board}/dashboard-widgets`;
    const bad = await createWidget(
      json("POST", href, { type: "link-list", config: { links: "Go|javascript:alert(1)" } }),
      boardParams(),
    );
    expect(bad.status).toBe(400);
    expect(await prisma.dashboardWidget.count({ where: { boardId: board } })).toBe(0);

    const good = await createWidget(
      json("POST", href, { type: "link-list", config: { links: "Go|https://evil.example" } }),
      boardParams(),
    );
    expect(good.status).toBe(201);
    const id = ((await good.json()) as { id: string }).id;

    const widgetParams = {
      params: Promise.resolve({ orgId: w.orgA, projectId: w.P1.id, boardId: board, widgetId: id }),
    };
    const update = await putWidget(
      json("PUT", `${href}/${id}`, { config: { links: "Go|/\t/evil.example" } }),
      widgetParams,
    );
    expect(update.status).toBe(400);
    const row = await prisma.dashboardWidget.findUniqueOrThrow({ where: { id } });
    expect(row.config).toEqual({ links: "Go|https://evil.example" });
  });
});
