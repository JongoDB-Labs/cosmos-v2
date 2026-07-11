import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listItemLinks, linkItems, unlinkItems } from "./work-items";
import type { ToolContext } from "./_ctx";

/** Covers the work-item DEPENDENCY LINK tools added to this executor. */
const NON_MEMBER = "00000000-0000-0000-0000-000000000000";

describe("work-item link executors (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({
      data: { name: `wl-test ${stamp}`, slug: `wl-test-${stamp}` },
    });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `WL${stamp.slice(-4).toUpperCase()}` },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const mk = (n: number) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: n, title: `wi-${n}`,
          description: "", columnKey: "todo", workItemTypeId: type.id, createdById: owner.id,
        },
      });
    const a = await mk(Math.floor(Math.random() * 1_000_000));
    const b = await mk(Math.floor(Math.random() * 1_000_000));
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    const denyCtx: ToolContext = { orgId: org.id, userId: NON_MEMBER };
    return { org, project, a, b, ctx, denyCtx };
  }

  it("link_items creates a directed link; list + unlink round-trip", async () => {
    const { ctx, project, a, b } = await makeOrg();
    const link = (await linkItems(
      { projectId: project.id, fromId: a.id, toId: b.id, type: "BLOCKS" },
      ctx,
    )) as { created: boolean; id: string };
    expect(link.created).toBe(true);
    expect(await prisma.workItemLink.count({ where: { id: link.id } })).toBe(1);

    const list = (await listItemLinks({ projectId: project.id }, ctx)) as {
      count: number;
      links: { type: string; sourceItemId: string }[];
    };
    expect(list.count).toBe(1);
    expect(list.links[0].type).toBe("BLOCKS");
    expect(list.links[0].sourceItemId).toBe(a.id);

    const del = (await unlinkItems({ projectId: project.id, linkId: link.id }, ctx)) as { deleted: boolean };
    expect(del.deleted).toBe(true);
    expect(await prisma.workItemLink.count({ where: { id: link.id } })).toBe(0);
  });

  it("rejects a self-link", async () => {
    const { ctx, project, a } = await makeOrg();
    expect(await linkItems({ projectId: project.id, fromId: a.id, toId: a.id, type: "RELATES" }, ctx)).toEqual({
      error: "A work item cannot link to itself",
    });
  });

  it("denies a non-member (no ITEM_* permission)", async () => {
    const { denyCtx, project, a, b } = await makeOrg();
    expect(await listItemLinks({ projectId: project.id }, denyCtx)).toEqual({ error: "Insufficient permissions" });
    expect(await linkItems({ projectId: project.id, fromId: a.id, toId: b.id, type: "BLOCKS" }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
    expect(await unlinkItems({ projectId: project.id, linkId: NON_MEMBER }, denyCtx)).toEqual({
      error: "Insufficient permissions",
    });
  });
});
