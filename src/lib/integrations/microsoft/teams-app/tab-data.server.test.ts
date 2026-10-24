// COSMOS-202 T1 d (e2e DB): the Teams tabs show what the person can read in
// Cosmos and nothing more: open items only, grouped by status, a restricted
// item as its key under "Restricted", and nothing from a project they can't open.
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { myWork, projectWork, tabProjects } from "./tab-data.server";
import type { TeamsUser } from "./identity.server";
import { ensureFixtureStatuses } from "@/lib/testing/db-fixtures";

const ORIGIN = "https://cosmos.example";

describe("Teams tab data (e2e DB)", () => {
  const orgIds: string[] = [];
  const createdTypes: string[] = [];
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
    await prisma.workItemType.deleteMany({ where: { id: { in: createdTypes } } }).catch(() => undefined);
  });

  async function taskType() {
    const t = await prisma.workItemType.findFirst({ where: { isBuiltIn: true, key: "software.task" } });
    if (t) return t;
    const made = await prisma.workItemType.create({ data: { key: "software.task", name: "Task", isBuiltIn: true } });
    createdTypes.push(made.id);
    return made;
  }

  async function setup() {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [alice, bob] = await Promise.all(["alice", "bob"].map((n) => prisma.user.findFirstOrThrow({ where: { email: `${n}@test.local` } })));
    const org = await prisma.organization.create({ data: { name: `tabs ${stamp}`, slug: `tabs-${stamp}` } });
    orgIds.push(org.id);
    await prisma.orgMember.createMany({ data: [{ orgId: org.id, userId: alice.id, role: "ADMIN" }, { orgId: org.id, userId: bob.id, role: "MEMBER" }] });
    const type = await taskType();
    const key = `TB${stamp.slice(-4).replace(/[^a-z0-9]/gi, "").toUpperCase()}X`;
    const project = await prisma.project.create({ data: { orgId: org.id, name: "Tabs project", key } });
    // Statuses as a real project has them, with categories: the tab reads them to tell open from done or cancelled.
    await ensureFixtureStatuses(project.id, ["todo", "in_progress", "shipped", "cancelled"], {
      todo: "TODO", in_progress: "IN_PROGRESS", shipped: "DONE", cancelled: "CANCELLED",
    });
    let n = 0;
    const item = (title: string, extra: object = {}) =>
      prisma.workItem.create({
        data: {
          orgId: org.id, projectId: project.id, ticketNumber: ++n, title, description: "", columnKey: "todo",
          workItemTypeId: type.id, createdById: alice.id, assigneeId: alice.id, assignees: { create: [{ userId: alice.id, sortOrder: 0 }] }, ...extra,
        },
      });
    await item("Write the plan");
    await item("Ship it", { columnKey: "in_progress" });
    await item("Done already", { columnKey: "shipped", completedAt: new Date() });
    // Done by its status's category, though nothing called it "done" or dated it.
    await item("Shipped but never dated", { columnKey: "shipped" });
    await item("Called off", { columnKey: "cancelled" });
    await item("Unassigned thing", { assigneeId: null, assignees: undefined });
    const as = async (u: { id: string }): Promise<TeamsUser> => ({
      orgId: org.id, slug: org.slug, userId: u.id, auth: { ...(await loadMemberAuthContext(org.id, u.id))!, isApiKey: false },
    });
    return { org, alice, bob, project, key, as };
  }

  it("My work: my open items, grouped by status, each linking to Cosmos", async () => {
    const s = await setup();
    const v = (await myWork(await s.as(s.alice), ORIGIN))!;
    expect(v.groups.map((g) => [g.status, g.items.map((i) => i.title)])).toEqual([
      ["In progress", ["Ship it"]],
      ["Todo", ["Write the plan"]],
    ]);
    expect(v.groups[0].items[0]).toMatchObject({ ref: `${s.key}-2`, url: `${ORIGIN}/${s.org.slug}/issues?item=${s.key}-2`, project: "Tabs project", assignee: "Alice" });
  });

  it("channel tab: a project's open items, and nothing for a project the person can't open", async () => {
    const s = await setup();
    const v = (await projectWork(await s.as(s.bob), ORIGIN, s.key.toLowerCase()))!;
    expect(v.title).toBe(`Tabs project (${s.key})`);
    expect(v.groups.flatMap((g) => g.items.map((i) => i.title)).sort()).toEqual(["Ship it", "Unassigned thing", "Write the plan"]);
    await prisma.project.update({ where: { id: s.project.id }, data: { teamScopedAccess: true } });
    expect(await projectWork(await s.as(s.bob), ORIGIN, s.key)).toBeNull();
    expect(await tabProjects(await s.as(s.bob))).toEqual([]);
    expect(await projectWork(await s.as(s.alice), ORIGIN, "NOPE")).toBeNull();
  });

  it("a restricted item is its key under 'Restricted', with no title, type, project or person", async () => {
    const s = await setup();
    await prisma.workItem.updateMany({ where: { projectId: s.project.id, ticketNumber: 1 }, data: { title: "CUI//SP-PRVCY payroll" } });
    const v = (await myWork(await s.as(s.alice), ORIGIN))!;
    const restricted = v.groups.find((g) => g.status === "Restricted")!;
    expect(restricted.items).toEqual([{ ref: `${s.key}-1`, url: `${ORIGIN}/${s.org.slug}/issues?item=${s.key}-1`, restricted: true }]);
    expect(JSON.stringify(v)).not.toContain("payroll");
  });

  it("a guest (items but not projects) can't put a project on a channel tab", async () => {
    const s = await setup();
    const carol = await prisma.user.findFirstOrThrow({ where: { email: "carol@test.local" } });
    const member = await prisma.orgMember.create({ data: { orgId: s.org.id, userId: carol.id, role: "GUEST" } });
    await prisma.projectMember.create({ data: { projectId: s.project.id, orgMemberId: member.id } });
    const u = await s.as(carol);
    expect(await tabProjects(u)).toEqual([]);
    expect(await projectWork(u, ORIGIN, s.key)).toBeNull();
  });

  it("a restricted project shows by key only, in the picker and as the tab title", async () => {
    const s = await setup();
    await prisma.dataClassification.create({ data: { orgId: s.org.id, projectId: s.project.id, level: "FOUO", appliedById: s.alice.id } });
    const u = await s.as(s.alice);
    expect(await tabProjects(u)).toEqual([{ key: s.key, label: s.key }]);
    const v = (await projectWork(u, ORIGIN, s.key))!;
    expect(v.title).toBe(s.key);
    expect(JSON.stringify(v)).not.toMatch(/Tabs project|Ship it|Write the plan/);
  });
});
