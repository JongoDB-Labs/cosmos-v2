import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listGoals, createGoal, updateGoal, listKpis, createKpi, updateKpi } from "./goals-kpis";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("goals + kpis executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `gk-test ${stamp}`, slug: `gk-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `GK${stamp.slice(-4).toUpperCase()}` },
    });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, project, ctx, denyCtx };
  }

  it("create_goal + update_goal persist and mutate", async () => {
    const { ctx, project } = await makeOrg();
    const created = (await createGoal({ projectId: project.id, title: "Ship v2" }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(created.created).toBe(true);
    const upd = (await updateGoal({ projectId: project.id, goalId: created.id, progress: 40, status: "ON_TRACK" }, ctx)) as {
      updated: boolean;
    };
    expect(upd.updated).toBe(true);
    const row = await prisma.goal.findUnique({ where: { id: created.id } });
    expect(row?.progress).toBe(40);
    expect(row?.status).toBe("ON_TRACK");
  });

  it("create_kpi + update_kpi persist and mutate", async () => {
    const { ctx, project } = await makeOrg();
    const created = (await createKpi({ projectId: project.id, name: "Velocity", targetValue: 30 }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(created.created).toBe(true);
    const upd = (await updateKpi({ projectId: project.id, kpiId: created.id, currentValue: 22 }, ctx)) as {
      updated: boolean;
    };
    expect(upd.updated).toBe(true);
    expect((await prisma.kpi.findUnique({ where: { id: created.id } }))?.currentValue).toBe(22);
  });

  it("list_goals / list_kpis round-trip created rows", async () => {
    const { ctx, project } = await makeOrg();
    await createGoal({ projectId: project.id, title: "G" }, ctx);
    await createKpi({ projectId: project.id, name: "K" }, ctx);
    expect(((await listGoals({ projectId: project.id }, ctx)) as { count: number }).count).toBe(1);
    expect(((await listKpis({ projectId: project.id }, ctx)) as { count: number }).count).toBe(1);
  });

  it("denies a non-member (no OKR_* permission)", async () => {
    const { denyCtx, project } = await makeOrg();
    expect(await listGoals({ projectId: project.id }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await createGoal({ projectId: project.id, title: "x" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await createKpi({ projectId: project.id, name: "x" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
  });
});
