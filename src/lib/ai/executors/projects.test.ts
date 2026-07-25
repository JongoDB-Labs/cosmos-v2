import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { createProject, updateProject, updateInterval, completeInterval, listProjects } from "./projects";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("projects + intervals executors (e2e DB)", () => {
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

  it("update_interval nests a sprint under a Program Increment", async () => {
    const { ctx, org } = await makeOrg();
    const project = await prisma.project.create({ data: { orgId: org.id, name: "P", key: "CYCKEY" } });
    const pi = await prisma.interval.create({
      data: {
        orgId: org.id, projectId: project.id, number: 1, name: "PI-1", intervalKind: "PROGRAM_INCREMENT",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-09-30"),
      },
    });
    const sprint = await prisma.interval.create({
      data: {
        orgId: org.id, projectId: project.id, number: 2, name: "S-1", intervalKind: "SPRINT",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-07-14"),
      },
    });
    const res = (await updateInterval({ projectId: project.id, intervalId: sprint.id, parentId: pi.id }, ctx)) as {
      updated: boolean;
    };
    expect(res.updated).toBe(true);
    expect((await prisma.interval.findUnique({ where: { id: sprint.id } }))?.parentId).toBe(pi.id);

    // A non-PI parent is rejected.
    expect(await updateInterval({ projectId: project.id, intervalId: pi.id, parentId: sprint.id }, ctx)).toEqual({
      error: "A sprint can only be nested under a Program Increment",
    });
  });

  it("complete_interval reports velocity and clears incomplete items", async () => {
    const { ctx, org, ownerId } = await makeOrg();
    const project = await prisma.project.create({ data: { orgId: org.id, name: "P", key: "DONEKEY" } });
    const interval = await prisma.interval.create({
      data: {
        orgId: org.id, projectId: project.id, number: 1, name: "S", intervalKind: "SPRINT", status: "ACTIVE",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-07-14"),
      },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const mk = (columnKey: string, storyPoints: number, n: number) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, intervalId: interval.id, ticketNumber: n, title: "t",
          description: "", columnKey, storyPoints, workItemTypeId: type.id, createdById: ownerId,
        },
      });
    await mk("done", 5, 1);
    const open = await mk("todo", 3, 2);

    const res = (await completeInterval({ projectId: project.id, intervalId: interval.id }, ctx)) as {
      completed: boolean;
      report: { velocity: number; completedItems: number; incompleteItems: number };
    };
    expect(res.completed).toBe(true);
    expect(res.report.velocity).toBe(5);
    expect(res.report.completedItems).toBe(1);
    expect(res.report.incompleteItems).toBe(1);
    expect((await prisma.interval.findUnique({ where: { id: interval.id } }))?.status).toBe("COMPLETED");
    // Incomplete item was returned to the backlog (interval cleared).
    expect((await prisma.workItem.findUnique({ where: { id: open.id } }))?.intervalId).toBeNull();
  });

  it("list_projects fuzzy-resolves a project the user names in words (bug #2)", async () => {
    const { ctx, org } = await makeOrg();
    await prisma.project.create({ data: { orgId: org.id, name: "Vital Signs Platform", key: "VITL" } });
    await prisma.project.create({ data: { orgId: org.id, name: "Marketing Site", key: "MKTG" } });
    await prisma.project.create({ data: { orgId: org.id, name: "Payroll", key: "PAY" } });

    // "VITL BMA" (extra word, wrong casing) must resolve to the VITL project.
    const byKeyPhrase = (await listProjects({ query: "VITL BMA" }, ctx)) as {
      count: number;
      projects: { key: string }[];
    };
    expect(byKeyPhrase.count).toBeGreaterThanOrEqual(1);
    expect(byKeyPhrase.projects[0].key).toBe("VITL");

    // Match on NAME tokens too.
    const byName = (await listProjects({ query: "vital" }, ctx)) as { projects: { key: string }[] };
    expect(byName.projects[0]?.key).toBe("VITL");

    // Match on KEY alone.
    const byKey = (await listProjects({ query: "mktg" }, ctx)) as { projects: { key: string }[] };
    expect(byKey.projects[0]?.key).toBe("MKTG");

    // No fuzzy hit ⇒ empty (so the model gets a clear "no match", not a dump).
    const none = (await listProjects({ query: "zzzznope" }, ctx)) as { count: number };
    expect(none.count).toBe(0);

    // No query ⇒ unchanged behavior: returns all active projects.
    const all = (await listProjects({}, ctx)) as { count: number };
    expect(all.count).toBe(3);
  });

  it("denies a non-member across the projects/intervals surface", async () => {
    const { denyCtx } = await makeOrg();
    expect(await createProject({ name: "x", key: "DENYKEY" }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await updateProject({ projectId: NON_MEMBER }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await updateInterval({ projectId: NON_MEMBER, intervalId: NON_MEMBER }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await completeInterval({ projectId: NON_MEMBER, intervalId: NON_MEMBER }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
  });
});
