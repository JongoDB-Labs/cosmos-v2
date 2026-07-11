import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listBoards } from "./boards";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("boards executor (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `bd-test ${stamp}`, slug: `bd-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `BD${stamp.slice(-4).toUpperCase()}` },
    });
    await prisma.board.create({
      data: { orgId: org.id, projectId: project.id, name: "Kanban", type: "KANBAN", sortOrder: 0 },
    });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, project, ctx, denyCtx };
  }

  it("list_boards returns the project's boards", async () => {
    const { ctx, project } = await makeOrg();
    const res = (await listBoards({ projectId: project.id }, ctx)) as {
      count: number;
      boards: { type: string }[];
    };
    expect(res.count).toBe(1);
    expect(res.boards[0].type).toBe("KANBAN");
  });

  it("rejects a foreign project id (org-scoping)", async () => {
    const { ctx } = await makeOrg();
    expect(await listBoards({ projectId: NON_MEMBER }, ctx)).toEqual({ error: "Project not found" });
  });

  it("denies a non-member (no BOARD_READ)", async () => {
    const { denyCtx, project } = await makeOrg();
    expect(await listBoards({ projectId: project.id }, denyCtx)).toEqual({ error: "Insufficient permissions" });
  });
});
