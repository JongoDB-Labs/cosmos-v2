import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { listItemLinks, linkItems, unlinkItems, createWorkItem, updateWorkItem } from "./work-items";
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

  it("rejects a link that would create a circular dependency", async () => {
    const { ctx, project, a, b } = await makeOrg();
    // A blocks B (a → b, so b depends on a).
    const first = (await linkItems(
      { projectId: project.id, fromId: a.id, toId: b.id, type: "BLOCKS" },
      ctx,
    )) as { created: boolean };
    expect(first.created).toBe(true);
    // B blocks A would close the loop — reject it, and don't persist a 2nd link.
    const loop = await linkItems(
      { projectId: project.id, fromId: b.id, toId: a.id, type: "BLOCKS" },
      ctx,
    );
    expect(loop).toEqual({
      error:
        "This link would create a circular dependency — the two items would each depend on the other.",
    });
    expect(await prisma.workItemLink.count({ where: { orgId: project.orgId } })).toBe(1);
  });

  it("rejects an exact-duplicate link", async () => {
    const { ctx, project, a, b } = await makeOrg();
    await linkItems({ projectId: project.id, fromId: a.id, toId: b.id, type: "RELATES" }, ctx);
    expect(
      await linkItems({ projectId: project.id, fromId: a.id, toId: b.id, type: "RELATES" }, ctx),
    ).toEqual({ error: "These items are already linked with that relationship." });
    expect(await prisma.workItemLink.count({ where: { orgId: project.orgId } })).toBe(1);
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

// Bug #1 (assign-to-me): a self-referential assignee token ("me"/"self"/"@me"/
// "myself") must resolve to the invoking user's id so "assign a ticket to me"
// works without the model knowing/echoing the uuid. Real uuids pass through.
describe("createWorkItem / updateWorkItem — self-assignee sentinel (e2e DB)", () => {
  const cleanup: { orgIds: string[] } = { orgIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const org = await prisma.organization.create({ data: { name: `wm-test ${stamp}`, slug: `wm-test-${stamp}` } });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: owner.id, role: "OWNER" } });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `WM${stamp.slice(-4).toUpperCase()}` },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    return { org, project, type, ctx, ownerId: owner.id };
  }

  it("create_work_item resolves assigneeId 'me' to the invoking user", async () => {
    const { project, type, ctx, ownerId } = await makeOrg();
    const res = (await createWorkItem(
      { projectId: project.id, title: "assign to me", workItemTypeId: type.id, assigneeId: "me" },
      ctx,
    )) as { created: boolean; id: string };
    expect(res.created).toBe(true);
    expect((await prisma.workItem.findUnique({ where: { id: res.id } }))?.assigneeId).toBe(ownerId);
  });

  it("accepts self tokens case/space/@-insensitively ('  Self ', '@me', 'myself')", async () => {
    const { project, type, ctx, ownerId } = await makeOrg();
    for (const token of ["  Self ", "@me", "MYSELF"]) {
      const res = (await createWorkItem(
        { projectId: project.id, title: `t ${token}`, workItemTypeId: type.id, assigneeId: token },
        ctx,
      )) as { created: boolean; id: string };
      expect(res.created).toBe(true);
      expect((await prisma.workItem.findUnique({ where: { id: res.id } }))?.assigneeId).toBe(ownerId);
    }
  });

  it("update_work_item resolves assigneeId 'me' to the invoking user", async () => {
    const { project, type, ctx, ownerId } = await makeOrg();
    const created = (await createWorkItem(
      { projectId: project.id, title: "unassigned", workItemTypeId: type.id },
      ctx,
    )) as { id: string };
    expect((await prisma.workItem.findUnique({ where: { id: created.id } }))?.assigneeId).toBeNull();

    const upd = (await updateWorkItem({ itemId: created.id, assigneeId: "me" }, ctx)) as { updated: boolean };
    expect(upd.updated).toBe(true);
    expect((await prisma.workItem.findUnique({ where: { id: created.id } }))?.assigneeId).toBe(ownerId);
  });

  it("passes an explicit uuid assignee through unchanged and leaves no-assignee null", async () => {
    const { project, type, ctx, ownerId } = await makeOrg();
    const withUuid = (await createWorkItem(
      { projectId: project.id, title: "explicit", workItemTypeId: type.id, assigneeId: ownerId },
      ctx,
    )) as { id: string };
    expect((await prisma.workItem.findUnique({ where: { id: withUuid.id } }))?.assigneeId).toBe(ownerId);

    const none = (await createWorkItem(
      { projectId: project.id, title: "none", workItemTypeId: type.id },
      ctx,
    )) as { id: string };
    expect((await prisma.workItem.findUnique({ where: { id: none.id } }))?.assigneeId).toBeNull();
  });
});
