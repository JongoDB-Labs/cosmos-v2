import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listMilestones, createMilestone, updateMilestone, deleteMilestone } from "./milestones";
import { memberToolCtx } from "@/lib/testing/tool-auth";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("milestones executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `ms-test ${stamp}`, slug: `ms-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `MS${stamp.slice(-4).toUpperCase()}` },
    });
    const ctx = await memberToolCtx(org.id, owner.id);
    const denyCtx = await memberToolCtx(org.id, NON_MEMBER);
    return { org, project, ctx, denyCtx };
  }

  it("create_milestone persists a row; update + delete mutate it", async () => {
    const { ctx, project } = await makeOrg();
    const created = (await createMilestone(
      { projectId: project.id, title: "Beta", dueDate: "2026-09-01T00:00:00.000Z" },
      ctx,
    )) as { created: boolean; id: string };
    expect(created.created).toBe(true);
    expect((await prisma.milestone.findUnique({ where: { id: created.id } }))?.title).toBe("Beta");

    const upd = (await updateMilestone(
      { projectId: project.id, milestoneId: created.id, status: "IN_PROGRESS" },
      ctx,
    )) as { updated: boolean };
    expect(upd.updated).toBe(true);
    expect((await prisma.milestone.findUnique({ where: { id: created.id } }))?.status).toBe("IN_PROGRESS");

    const del = (await deleteMilestone({ projectId: project.id, milestoneId: created.id }, ctx)) as {
      deleted: boolean;
    };
    expect(del.deleted).toBe(true);
    expect(await prisma.milestone.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it("list_milestones round-trips created rows", async () => {
    const { ctx, project } = await makeOrg();
    await createMilestone({ projectId: project.id, title: "GA", dueDate: "2026-10-01T00:00:00.000Z" }, ctx);
    const list = (await listMilestones({ projectId: project.id }, ctx)) as { count: number };
    expect(list.count).toBe(1);
  });

  it("denies a non-member (no PROJECT_* permission)", async () => {
    const { denyCtx, project } = await makeOrg();
    // The read and the write now refuse DIFFERENTLY, deliberately. A list still
    // answers "Insufficient permissions" from its own permission pre-check; a
    // write answers "Project not found" because its refusal comes from
    // `assertProjectManage`, which checks VISIBILITY first — a project you
    // cannot open must read as absent, not forbidden, so a refusal cannot be
    // used to discover what exists (_ctx.ts). The org-wide pre-check that used
    // to answer for the writes was removed: it short-circuited the
    // project-MANAGER branch the matching routes allow.
    //
    // The COUNT assertions matter more than the strings: a message can be
    // edited to match whatever the code says, a row cannot.
    expect(await listMilestones({ projectId: project.id }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(
      await createMilestone({ projectId: project.id, title: "x", dueDate: "2026-10-01T00:00:00.000Z" }, denyCtx),
    ).toEqual({ error: "Project not found" });

    expect(await prisma.milestone.count({ where: { projectId: project.id } })).toBe(0);
  });
});
