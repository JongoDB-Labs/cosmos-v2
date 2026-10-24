// @vitest-environment node
//
// COSMOS-231: a new Kanban board (Issues' "Save as board") gets columns, and
// every one of them is a view onto a status the project has. Against the REAL
// e2e DB in a throwaway org; only getAuthContext is mocked.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { RolePermissions } from "@/lib/rbac/permissions";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { DEFAULT_COLUMNS } from "@/lib/boards/default-columns";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { POST } from "./route";

let orgId: string;
let userId: string;

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = (await prisma.organization.create({ data: { name: `boards ${stamp}`, slug: `boards-${stamp}` } })).id;
  userId = (await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } })).id;
  await prisma.orgMember.create({ data: { orgId, userId, role: "ADMIN" } });
  getAuthContext.mockResolvedValue({
    userId,
    orgId,
    orgRole: "ADMIN",
    permissions: RolePermissions.ADMIN,
    basePermissions: RolePermissions.ADMIN,
    abacRules: [],
  });
});

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } });
});

const project = async (key: string) => (await prisma.project.create({ data: { orgId, name: key, key } })).id;
const create = async (projectId: string, body: Record<string, unknown>) => {
  const res = await POST(
    new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ orgId, projectId }) } as never,
  );
  expect(res.status).toBe(201);
  const j = await res.json();
  return (j.data ?? j) as { id: string; columns: { key: string; name: string; category: string }[] };
};
const statusKeys = async (projectId: string) =>
  new Set((await prisma.workflowStatus.findMany({ where: { projectId } })).map((s) => s.key));

describe("POST /boards (e2e DB)", () => {
  it("gives a new Kanban board the project's main Kanban columns", async () => {
    const pid = await project("KBA");
    const main = await prisma.board.create({ data: { orgId, projectId: pid, name: "Main", type: "KANBAN", sortOrder: 0 } });
    await prisma.$transaction((tx) =>
      seedBoardColumns(tx, { ...main, projectId: pid }, [
        { name: "Ideas", key: "ideas", category: "TODO" },
        { name: "Building", key: "building", category: "IN_PROGRESS" },
        { name: "Shipped", key: "shipped", category: "DONE" },
      ]),
    );

    const board = await create(pid, { name: "My saved view", type: "KANBAN" });
    // Exactly the seeded set: never registry defaults on top of it.
    expect(new Set(board.columns.map((c) => c.key)).size).toBe(board.columns.length);
    expect(board.columns.map((c) => [c.key, c.name, c.category])).toEqual([
      ["ideas", "Ideas", "TODO"],
      ["building", "Building", "IN_PROGRESS"],
      ["shipped", "Shipped", "DONE"],
    ]);
    const keys = await statusKeys(pid);
    for (const c of board.columns) expect(keys.has(c.key)).toBe(true);
  });

  it("falls back to the default columns, with their statuses, when the project has no Kanban board", async () => {
    const pid = await project("KBB");
    const board = await create(pid, { name: "First board", type: "KANBAN" });
    expect(board.columns.map((c) => c.key)).toEqual(DEFAULT_COLUMNS.map((c) => c.key));
    const keys = await statusKeys(pid);
    for (const c of board.columns) expect(keys.has(c.key)).toBe(true); // no orphan column
  });

  it("seeds a new Scrum board the same way", async () => {
    const withMain = await project("KBD");
    const main = await prisma.board.create({ data: { orgId, projectId: withMain, name: "Main", type: "KANBAN", sortOrder: 0 } });
    await prisma.$transaction((tx) =>
      seedBoardColumns(tx, { ...main, projectId: withMain }, [
        { name: "Open", key: "open", category: "TODO" },
        { name: "Closed", key: "closed", category: "DONE" },
      ]),
    );
    expect((await create(withMain, { name: "Sprint", type: "SCRUM" })).columns.map((c) => c.key)).toEqual(["open", "closed"]);

    const bare = await project("KBE");
    const board = await create(bare, { name: "Sprint", type: "SCRUM" });
    expect(board.columns.map((c) => c.key)).toEqual(DEFAULT_COLUMNS.map((c) => c.key));
    const keys = await statusKeys(bare);
    for (const c of board.columns) expect(keys.has(c.key)).toBe(true);
  });

  it("leaves a ceremony board with its own columns", async () => {
    const pid = await project("KBC");
    const board = await create(pid, { name: "Retro", type: "SPRINT_REVIEW" });
    expect(board.columns.map((c) => c.key).sort()).toEqual(["continue", "start", "stop"]);
  });
});
