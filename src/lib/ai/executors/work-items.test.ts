import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import {
  listItemLinks,
  linkItems,
  unlinkItems,
  createWorkItem,
  updateWorkItem,
  listWorkItems,
} from "./work-items";
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

// COSMOS-192: "when COSMO creates or mucks with tickets and assigns to people, it
// assigns to the UUID and doesn't actually put the NAME on the ticket".
//
// Two halves, both here:
//  - the executor wrote only the legacy scalar `assigneeId` and never the
//    `WorkItemAssignee` SET the REST routes maintain, so the ticket's Assignees
//    control — which reads the set — had nothing to show;
//  - the result handed back to the model carried the id alone, so Cosmo could
//    only report the GUID it had been given.
describe("createWorkItem / updateWorkItem — assignee resolves to a person (e2e DB)", () => {
  const cleanup: { orgIds: string[]; userIds: string[] } = { orgIds: [], userIds: [] };
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: cleanup.orgIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } }).catch(() => undefined);
  });

  async function makeOrg() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "alice@test.local" } });
    const other = await prisma.user.findFirstOrThrow({ where: { email: "bob@test.local" } });
    // A real, NAMED person who belongs to ANOTHER tenant — so an unscoped
    // directory lookup would happily name them on this org's ticket.
    const outsider = await prisma.user.create({
      data: { email: `outsider-${stamp}@test.local`, displayName: "Outsider" },
    });
    cleanup.userIds.push(outsider.id);
    const otherOrg = await prisma.organization.create({
      data: { name: `wn-other ${stamp}`, slug: `wn-other-${stamp}` },
    });
    cleanup.orgIds.push(otherOrg.id);
    await prisma.orgMember.create({
      data: { orgId: otherOrg.id, userId: outsider.id, role: "MEMBER" },
    });
    const org = await prisma.organization.create({ data: { name: `wn-test ${stamp}`, slug: `wn-test-${stamp}` } });
    cleanup.orgIds.push(org.id);
    await prisma.orgMember.createMany({
      data: [
        { orgId: org.id, userId: owner.id, role: "OWNER" as const },
        { orgId: org.id, userId: other.id, role: "MEMBER" as const },
      ],
    });
    const project = await prisma.project.create({
      data: { orgId: org.id, name: "P", key: `WN${stamp.slice(-4).toUpperCase()}` },
    });
    const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
    const ctx: ToolContext = { orgId: org.id, userId: owner.id };
    return { org, project, type, ctx, owner, other, outsider };
  }

  it("create names the assignee and records them in the multi-assign set", async () => {
    const { project, type, ctx, other } = await makeOrg();
    const res = (await createWorkItem(
      { projectId: project.id, title: "named", workItemTypeId: type.id, assigneeId: other.id },
      ctx,
    )) as { id: string; assigneeId: string | null; assigneeName: string | null };

    expect(res.assigneeId).toBe(other.id);
    expect(res.assigneeName).toBe(other.displayName); // "Bob", not the uuid
    expect(
      await prisma.workItemAssignee.findMany({
        where: { workItemId: res.id },
        select: { userId: true },
      }),
    ).toEqual([{ userId: other.id }]);
  });

  it("update names the new assignee and promotes them to the front of the set", async () => {
    const { project, type, ctx, owner, other } = await makeOrg();
    const created = (await createWorkItem(
      { projectId: project.id, title: "reassigned", workItemTypeId: type.id, assigneeId: owner.id },
      ctx,
    )) as { id: string };

    const upd = (await updateWorkItem({ itemId: created.id, assigneeId: other.id }, ctx)) as {
      assigneeId: string | null;
      assigneeName: string | null;
    };
    expect(upd.assigneeId).toBe(other.id);
    expect(upd.assigneeName).toBe(other.displayName);

    const set = await prisma.workItemAssignee.findMany({
      where: { workItemId: created.id },
      orderBy: { sortOrder: "asc" },
      select: { userId: true },
    });
    expect(set[0]).toEqual({ userId: other.id });
  });

  it("clearing the assignee clears the set and reports no name", async () => {
    const { project, type, ctx, other } = await makeOrg();
    const created = (await createWorkItem(
      { projectId: project.id, title: "cleared", workItemTypeId: type.id, assigneeId: other.id },
      ctx,
    )) as { id: string };

    const upd = (await updateWorkItem({ itemId: created.id, assigneeId: null }, ctx)) as {
      assigneeId: string | null;
      assigneeName: string | null;
    };
    expect(upd.assigneeId).toBeNull();
    expect(upd.assigneeName).toBeNull();
    expect(await prisma.workItemAssignee.count({ where: { workItemId: created.id } })).toBe(0);
  });

  it("lists existing items with the assignee's name resolved from the id", async () => {
    const { project, type, ctx, other } = await makeOrg();
    // Written the way rows created BEFORE this fix look: the scalar only, no set.
    const legacy = await prisma.workItem.create({
      data: {
        orgId: ctx.orgId, projectId: project.id, ticketNumber: 4242, title: "legacy",
        description: "", columnKey: "todo", workItemTypeId: type.id,
        createdById: ctx.userId, assigneeId: other.id,
      },
    });

    const list = (await listWorkItems({ projectId: project.id }, ctx)) as {
      items: { id: string; assigneeId: string | null; assigneeName: string | null }[];
    };
    const row = list.items.find((i) => i.id === legacy.id);
    expect(row?.assigneeName).toBe(other.displayName);
  });

  it("refuses an assignee from another org rather than parking a nameless id", async () => {
    const { project, type, ctx, outsider } = await makeOrg();
    // A real, NAMED user id belonging to ANOTHER org. Naming them would leak a
    // name across the tenant boundary; storing them would put an id on the
    // ticket that no surface here can ever resolve — which is the reported bug.
    const res = (await createWorkItem(
      { projectId: project.id, title: "outsider", workItemTypeId: type.id, assigneeId: outsider.id },
      ctx,
    )) as { created?: boolean; error?: string };
    expect(res.created).toBeUndefined();
    expect(res.error).toMatch(/not a member of this organization/);
    // Actionable: names the lookup tool, and never echoes the id back.
    expect(res.error).toContain("list_org_members");
    expect(res.error).not.toContain(outsider.id);
    expect(await prisma.workItem.count({ where: { projectId: project.id } })).toBe(0);

    // …and the same on the reassign path, which has its own call site.
    const mine = (await createWorkItem(
      { projectId: project.id, title: "mine", workItemTypeId: type.id },
      ctx,
    )) as { id: string };
    const upd = (await updateWorkItem({ itemId: mine.id, assigneeId: outsider.id }, ctx)) as {
      updated?: boolean;
      error?: string;
    };
    expect(upd.updated).toBeUndefined();
    expect(upd.error).toMatch(/not a member of this organization/);
    expect((await prisma.workItem.findUnique({ where: { id: mine.id } }))?.assigneeId).toBeNull();
  });

  it("names nobody for an assignee id the directory cannot resolve, without failing the read", async () => {
    const { project, type, ctx, outsider } = await makeOrg();
    // A row that predates the guard above: the scalar holds an id this org
    // cannot name. Listing must return null, never an invented name.
    const orphan = await prisma.workItem.create({
      data: {
        orgId: ctx.orgId, projectId: project.id, ticketNumber: 99, title: "orphan",
        description: "", columnKey: "todo", workItemTypeId: type.id,
        createdById: ctx.userId, assigneeId: outsider.id,
      },
    });

    const list = (await listWorkItems({ projectId: project.id }, ctx)) as {
      items: { id: string; assigneeId: string | null; assigneeName: string | null }[];
    };
    const row = list.items.find((i) => i.id === orphan.id);
    expect(row?.assigneeId).toBe(outsider.id);
    expect(row?.assigneeName).toBeNull();
  });
});
