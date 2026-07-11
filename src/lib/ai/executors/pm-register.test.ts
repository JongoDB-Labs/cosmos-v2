import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import {
  createBlocker,
  updateBlocker,
  createDeliverable,
  updateDeliverable,
  createChangeRequest,
  updateChangeRequest,
  listBlockers,
} from "./pm-register";
import type { ToolContext } from "./_ctx";

const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("pm-register write executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `pm-test ${stamp}`, slug: `pm-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `PM${stamp.slice(-4).toUpperCase()}` },
    });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, project, ctx, denyCtx };
  }

  it("create_blocker auto-codes BL-001 and update mutates status", async () => {
    const { ctx, project } = await makeOrg();
    const created = (await createBlocker(
      { projectId: project.id, title: "Waiting on ATO", type: "EXTERNAL_GOVERNMENT" },
      ctx,
    )) as { created: boolean; id: string };
    expect(created.created).toBe(true);
    const row = await prisma.blocker.findUnique({ where: { id: created.id } });
    expect(row?.code).toBe("BL-001");
    expect(row?.type).toBe("EXTERNAL_GOVERNMENT");

    const upd = (await updateBlocker({ projectId: project.id, blockerId: created.id, status: "RESOLVED" }, ctx)) as {
      updated: boolean;
    };
    expect(upd.updated).toBe(true);
    expect((await prisma.blocker.findUnique({ where: { id: created.id } }))?.status).toBe("RESOLVED");
  });

  it("create_deliverable auto-codes CDRL-A001 and update mutates status", async () => {
    const { ctx, project } = await makeOrg();
    const created = (await createDeliverable({ projectId: project.id, title: "SDP" }, ctx)) as {
      created: boolean;
      id: string;
    };
    expect((await prisma.deliverable.findUnique({ where: { id: created.id } }))?.code).toBe("CDRL-A001");
    await updateDeliverable({ projectId: project.id, deliverableId: created.id, status: "SUBMITTED" }, ctx);
    expect((await prisma.deliverable.findUnique({ where: { id: created.id } }))?.status).toBe("SUBMITTED");
  });

  it("create_change_request auto-codes CR-001 and update mutates status", async () => {
    const { ctx, project } = await makeOrg();
    const created = (await createChangeRequest(
      { projectId: project.id, title: "Scope bump", scheduleDaysImpact: 5 },
      ctx,
    )) as { created: boolean; id: string };
    expect((await prisma.changeRequest.findUnique({ where: { id: created.id } }))?.code).toBe("CR-001");
    await updateChangeRequest({ projectId: project.id, changeId: created.id, status: "APPROVED" }, ctx);
    expect((await prisma.changeRequest.findUnique({ where: { id: created.id } }))?.status).toBe("APPROVED");
  });

  it("list_blockers round-trips created rows", async () => {
    const { ctx, project } = await makeOrg();
    await createBlocker({ projectId: project.id, title: "b" }, ctx);
    const list = (await listBlockers({ projectId: project.id }, ctx)) as { count: number };
    expect(list.count).toBe(1);
  });

  it("denies a non-member (no PROJECT_UPDATE)", async () => {
    const { denyCtx, project } = await makeOrg();
    expect(await createBlocker({ projectId: project.id, title: "x" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await createDeliverable({ projectId: project.id, title: "x" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await createChangeRequest({ projectId: project.id, title: "x" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
  });
});
