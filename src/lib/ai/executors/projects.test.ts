import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { createProject, updateProject, updateCycle, completeCycle } from "./projects";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("projects + cycles executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `pj-test ${stamp}`, slug: `pj-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, ctx, denyCtx, ownerId: owner.id };
  }

  it("create_project persists a project + default board + membership; key is unique", async () => {
    const { ctx } = await makeOrg();
    const res = (await createProject({ name: "New", key: "NEWKEY", description: "d" }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect(res.created).toBe(true);
    const proj = await prisma.project.findUnique({ where: { id: res.id }, include: { boards: true, members: true } });
    expect(proj?.key).toBe("NEWKEY");
    expect(proj?.boards.length).toBe(1);
    expect(proj?.members.length).toBe(1);

    // Duplicate key in the same org is refused.
    expect(await createProject({ name: "Dup", key: "NEWKEY" }, ctx)).toEqual({ error: "Project key already exists" });
  });

  it("update_project changes name + archived", async () => {
    const { ctx, org } = await makeOrg();
    const project = await prisma.project.create({ data: { orgId: org.id, name: "Old", key: "UPDKEY" } });
    const res = (await updateProject({ projectId: project.id, name: "Renamed", archived: true }, ctx)) as {
      updated: boolean;
    };
    expect(res.updated).toBe(true);
    const row = await prisma.project.findUnique({ where: { id: project.id } });
    expect(row?.name).toBe("Renamed");
    expect(row?.archived).toBe(true);
  });

  it("update_cycle nests a sprint under a Program Increment", async () => {
    const { ctx, org } = await makeOrg();
    const project = await prisma.project.create({ data: { orgId: org.id, name: "P", key: "CYCKEY" } });
    const pi = await prisma.cycle.create({
      data: {
        orgId: org.id, projectId: project.id, number: 1, name: "PI-1", cycleKind: "PROGRAM_INCREMENT",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-09-30"),
      },
    });
    const sprint = await prisma.cycle.create({
      data: {
        orgId: org.id, projectId: project.id, number: 2, name: "S-1", cycleKind: "SPRINT",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-07-14"),
      },
    });
    const res = (await updateCycle({ projectId: project.id, cycleId: sprint.id, parentId: pi.id }, ctx)) as {
      updated: boolean;
    };
    expect(res.updated).toBe(true);
    expect((await prisma.cycle.findUnique({ where: { id: sprint.id } }))?.parentId).toBe(pi.id);

    // A non-PI parent is rejected.
    expect(await updateCycle({ projectId: project.id, cycleId: pi.id, parentId: sprint.id }, ctx)).toEqual({
      error: "A sprint can only be nested under a Program Increment",
    });
  });

  it("complete_cycle reports velocity and clears incomplete items", async () => {
    const { ctx, org, ownerId } = await makeOrg();
    const project = await prisma.project.create({ data: { orgId: org.id, name: "P", key: "DONEKEY" } });
    const cycle = await prisma.cycle.create({
      data: {
        orgId: org.id, projectId: project.id, number: 1, name: "S", cycleKind: "SPRINT", status: "ACTIVE",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-07-14"),
      },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const mk = (columnKey: string, storyPoints: number, n: number) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, cycleId: cycle.id, ticketNumber: n, title: "t",
          description: "", columnKey, storyPoints, workItemTypeId: type.id, createdById: ownerId,
        },
      });
    await mk("done", 5, 1);
    const open = await mk("todo", 3, 2);

    const res = (await completeCycle({ projectId: project.id, cycleId: cycle.id }, ctx)) as {
      completed: boolean;
      report: { velocity: number; completedItems: number; incompleteItems: number };
    };
    expect(res.completed).toBe(true);
    expect(res.report.velocity).toBe(5);
    expect(res.report.completedItems).toBe(1);
    expect(res.report.incompleteItems).toBe(1);
    expect((await prisma.cycle.findUnique({ where: { id: cycle.id } }))?.status).toBe("COMPLETED");
    // Incomplete item was returned to the backlog (cycle cleared).
    expect((await prisma.workItem.findUnique({ where: { id: open.id } }))?.cycleId).toBeNull();
  });

  it("denies a non-member across the projects/cycles surface", async () => {
    const { denyCtx } = await makeOrg();
    expect(await createProject({ name: "x", key: "DENYKEY" }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await updateProject({ projectId: NON_MEMBER }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await updateCycle({ projectId: NON_MEMBER, cycleId: NON_MEMBER }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await completeCycle({ projectId: NON_MEMBER, cycleId: NON_MEMBER }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
  });
});
