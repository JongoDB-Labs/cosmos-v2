/**
 * A seeded world for the CQL database tests (`*.db.test.ts`).
 *
 * Two orgs. Org A has:
 *   P1  open; the actor is a member
 *   P2  teamScopedAccess; the actor is NOT a member (restricted)
 *   P3  open, but the actor's ABAC rules deny ITEM_READ there (via `denyP3`)
 * Org B mirrors A with the same project keys, labels and sprint names, so a
 * leak across orgs or projects shows up as a matching value in the wrong place.
 *
 * Items in the restricted projects carry values that EXACTLY match readable
 * ones (same sprint name, same label, same type), which is what a scope bug
 * would leak. Every row is created fresh per suite with a unique stamp and
 * deleted with its orgs.
 */
import { prisma } from "@/lib/db/client";
import { createWorkItemRow, updateWorkItems } from "@/lib/work-items/write.server";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { OrgRole } from "@prisma/client";
import { Permission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";

export interface World {
  stamp: string;
  orgA: string;
  orgB: string;
  actor: { id: string; email: string };
  bob: { id: string };
  alex1: { id: string };
  alex2: { id: string };
  P1: { id: string; key: string };
  P2: { id: string; key: string };
  P3: { id: string; key: string };
  B1: { id: string; key: string };
  sprintP1Active: string;
  sprintP1Done: string;
  sprintP1Planned: string;
  sprintP2Active: string;
  teamP1: string;
  teamP2: string;
  labels: { auth: string; urgent: string; secret: string };
  typeTask: string;
  typeBug: string;
  items: Record<string, { id: string; projectId: string; ticketNumber: number }>;
  /** Names that exist ONLY in restricted places; no response to the actor may contain them. */
  secrets: string[];
  ctx(opts?: { role?: OrgRole; denyP3?: boolean; projectScope?: string[] }): AuthContext;
  cleanup(): Promise<void>;
}

export async function seedWorld(): Promise<World> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mkUser = (name: string, email: string) =>
    prisma.user.create({ data: { email: `${email}-${stamp}@test.local`, displayName: name } });
  const actor = await mkUser("Ada Actor", "ada");
  const bob = await mkUser("Bob Builder", "bob");
  const alex1 = await mkUser("Alex Same", "alex1");
  const alex2 = await mkUser("Alex Same", "alex2");
  const ghost = await mkUser(`Ghost Secretperson ${stamp}`, "ghost");

  const orgA = await prisma.organization.create({ data: { name: `cqlA ${stamp}`, slug: `cqla-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `cqlB ${stamp}`, slug: `cqlb-${stamp}` } });
  const memberOf = async (orgId: string, userId: string) =>
    prisma.orgMember.create({ data: { orgId, userId, role: "MEMBER" } });
  const mA = await memberOf(orgA.id, actor.id);
  const mBob = await memberOf(orgA.id, bob.id);
  await memberOf(orgA.id, alex1.id);
  await memberOf(orgA.id, alex2.id);
  const mGhost = await memberOf(orgA.id, ghost.id);
  await memberOf(orgB.id, actor.id);

  const key = (k: string) => `${k}${stamp.slice(-3).toUpperCase().replace(/[^A-Z]/g, "Q")}`;
  const mkProject = async (orgId: string, k: string, extra: Record<string, unknown> = {}) => {
    const p = await prisma.project.create({ data: { orgId, name: `Project ${k}`, key: key(k), ...extra } });
    const board = await prisma.board.create({ data: { orgId, projectId: p.id, name: "Board", type: "KANBAN" } });
    // Through the provisioning path, so each column's status exists too.
    await seedBoardColumns(prisma, board, [
      { key: "todo", name: "To Do", category: "TODO" },
      { key: "in-progress", name: "In Progress", category: "IN_PROGRESS" },
      { key: "review", name: k === "PB" ? "Secret Review Lane" : "Review", category: "IN_PROGRESS" },
      { key: "done", name: "Done", category: "DONE" },
      { key: "cancelled", name: "Cancelled", category: "CANCELLED" },
    ]);
    return { id: p.id, key: p.key };
  };
  const P1 = await mkProject(orgA.id, "PA");
  const P2 = await mkProject(orgA.id, "PB", { teamScopedAccess: true, name: `Secretproject ${stamp}` });
  const P3 = await mkProject(orgA.id, "PC");
  const B1 = await mkProject(orgB.id, "PA");
  const pm = await prisma.projectMember.create({ data: { projectId: P1.id, orgMemberId: mA.id } });
  await prisma.projectMember.create({ data: { projectId: P3.id, orgMemberId: mA.id } });
  const pmBob = await prisma.projectMember.create({ data: { projectId: P1.id, orgMemberId: mBob.id } });
  const pmGhost = await prisma.projectMember.create({ data: { projectId: P2.id, orgMemberId: mGhost.id } });
  void pm;

  const sprint = (orgId: string, projectId: string, number: number, name: string, status: "ACTIVE" | "COMPLETED" | "PLANNED") =>
    prisma.interval.create({
      data: { orgId, projectId, number, name, status, startDate: new Date("2026-10-01"), endDate: new Date("2026-10-14") },
    });
  const sprintP1Active = (await sprint(orgA.id, P1.id, 1, "Sprint 1", "ACTIVE")).id;
  const sprintP1Done = (await sprint(orgA.id, P1.id, 2, "Sprint 0", "COMPLETED")).id;
  const sprintP1Planned = (await sprint(orgA.id, P1.id, 3, "Sprint 2", "PLANNED")).id;
  const sprintP2Active = (await sprint(orgA.id, P2.id, 1, "Sprint 1", "ACTIVE")).id;
  await sprint(orgA.id, P2.id, 2, `Secretsprint ${stamp}`, "PLANNED");
  await sprint(orgB.id, B1.id, 1, "Sprint 1", "ACTIVE");

  const teamP1 = (await prisma.team.create({ data: { orgId: orgA.id, projectId: P1.id, name: "Platform" } })).id;
  const teamP2 = (await prisma.team.create({ data: { orgId: orgA.id, projectId: P2.id, name: `Secretteam ${stamp}` } })).id;
  await prisma.teamMember.create({ data: { teamId: teamP1, projectMemberId: pmBob.id } });
  await prisma.teamMember.create({ data: { teamId: teamP2, projectMemberId: pmGhost.id } });

  const label = (orgId: string, name: string) => prisma.label.create({ data: { orgId, name } });
  const labels = {
    auth: (await label(orgA.id, "auth")).id,
    urgent: (await label(orgA.id, "urgent")).id,
    secret: (await label(orgA.id, `secretlabel-${stamp}`)).id,
  };
  await label(orgB.id, "auth");

  const typeTask = (await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } })).id;
  const typeBug = (await prisma.workItemType.create({ data: { orgId: orgA.id, key: "bug", name: "Bug" } })).id;

  await prisma.customField.create({ data: { orgId: orgA.id, key: `sev_${stamp}`, name: "Severity", fieldType: "SELECT", options: ["S1", "S2", "S3"] } });

  const counters = new Map<string, number>();
  const items: World["items"] = {};
  const mkItem = async (
    name: string,
    orgId: string,
    projectId: string,
    data: Record<string, unknown> = {},
    rel: { labels?: string[]; assignees?: string[]; watchers?: string[] } = {},
  ) => {
    const n = (counters.get(projectId) ?? 0) + 1;
    counters.set(projectId, n);
    const row = await createWorkItemRow(prisma, {
      data: {
        orgId, projectId, ticketNumber: n, title: name, description: "", columnKey: "todo",
        workItemTypeId: typeTask, createdById: actor.id, ...data,
      },
    }, { actorId: null, source: "SYSTEM" });
    // Labels as lib/work-items/labels.ts writes them: the relation is the truth
    // and `tags` mirrors the names (the legacy filter reads the mirror).
    for (const labelId of rel.labels ?? []) await prisma.workItemLabel.create({ data: { orgId, workItemId: row.id, labelId } });
    if (rel.labels?.length) {
      const names = await prisma.label.findMany({ where: { id: { in: rel.labels } }, select: { name: true } });
      await updateWorkItems(prisma, [row.id], { tags: names.map((n) => n.name) }, { actorId: null, source: "SYSTEM" });
    }
    for (const [i, userId] of (rel.assignees ?? []).entries()) {
      await prisma.workItemAssignee.create({ data: { workItemId: row.id, userId, sortOrder: i } });
    }
    for (const userId of rel.watchers ?? []) await prisma.workItemWatcher.create({ data: { orgId, workItemId: row.id, userId } });
    items[name] = { id: row.id, projectId, ticketNumber: n };
    return row;
  };

  const A = orgA.id;
  await mkItem("p1-login-bug", A, P1.id, {
    workItemTypeId: typeBug, priority: "CRITICAL", assigneeId: actor.id, intervalId: sprintP1Active, columnKey: "in-progress",
    dueDate: new Date("2026-10-20T00:00:00Z"), storyPoints: 5, customFields: { [`sev_${stamp}`]: "S1" },
    highlight: "RED", teamId: teamP1, originalEstimate: 4 * 3600,
  }, { labels: [labels.auth], watchers: [actor.id] });
  await mkItem("p1-unassigned", A, P1.id, { priority: "LOW", intervalId: sprintP1Planned, description: "touches the LOGIN page" });
  await mkItem("p1-coowned", A, P1.id, { priority: "HIGH", columnKey: "review" }, { assignees: [bob.id], labels: [labels.urgent] });
  await mkItem("p1-done", A, P1.id, { priority: "MEDIUM", columnKey: "done", completedAt: new Date("2026-10-10T12:00:00Z"), intervalId: sprintP1Done, assigneeId: bob.id });
  await mkItem("p1-archived", A, P1.id, { archivedAt: new Date("2026-09-01T00:00:00Z"), assigneeId: actor.id });
  await mkItem("p1-child", A, P1.id, { parentId: undefined, workCategory: "ENABLER", cancelReason: "OBE", columnKey: "cancelled" });
  await updateWorkItems(prisma, [items["p1-child"].id], { parentId: items["p1-login-bug"].id }, { actorId: null, source: "SYSTEM" });
  await prisma.workItemLink.create({ data: { orgId: A, sourceItemId: items["p1-coowned"].id, targetItemId: items["p1-unassigned"].id, type: "BLOCKS" } });

  // Restricted twins: values identical to readable ones.
  await mkItem(`p2-secret-${stamp}`, A, P2.id, {
    workItemTypeId: typeBug, priority: "CRITICAL", assigneeId: actor.id, intervalId: sprintP2Active, columnKey: "in-progress",
    teamId: teamP2, title: `Secretitem ${stamp} login`,
  }, { labels: [labels.auth, labels.secret], watchers: [actor.id] });
  await mkItem(`p3-denied-${stamp}`, A, P3.id, { priority: "CRITICAL", assigneeId: actor.id }, { labels: [labels.auth] });
  await mkItem(`b1-otherorg-${stamp}`, orgB.id, B1.id, { priority: "CRITICAL", assigneeId: actor.id });

  const denyP3: AbacRule = { effect: "deny", actions: ["ITEM_READ"], conditions: [{ attr: "projectId", op: "eq", value: P3.id }] };

  return {
    stamp,
    orgA: A,
    orgB: orgB.id,
    actor: { id: actor.id, email: actor.email },
    bob: { id: bob.id },
    alex1: { id: alex1.id },
    alex2: { id: alex2.id },
    P1, P2, P3, B1,
    sprintP1Active, sprintP1Done, sprintP1Planned, sprintP2Active,
    teamP1, teamP2, labels, typeTask, typeBug, items,
    // Labels are an org-wide catalogue, so a label name is not a secret even
    // when only restricted items carry it.
    secrets: [`Secretproject ${stamp}`, `Secretsprint ${stamp}`, `Secretteam ${stamp}`, `Secretitem ${stamp}`, `Ghost Secretperson ${stamp}`, "Secret Review Lane", P2.key],
    ctx(opts = {}) {
      const permissions = Permission.ITEM_READ;
      return {
        userId: actor.id,
        orgId: A,
        orgRole: opts.role ?? OrgRole.MEMBER,
        permissions,
        basePermissions: permissions,
        // An ABAC deny on P3 alone, resolved per project by getReadableProjectIds.
        abacRules: opts.denyP3 ? [denyP3] : [],
        ...(opts.projectScope ? { projectScope: opts.projectScope } : {}),
      } as AuthContext;
    },
    async cleanup() {
      await prisma.organization.deleteMany({ where: { id: { in: [A, orgB.id] } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: [actor.id, bob.id, alex1.id, alex2.id, ghost.id] } } }).catch(() => undefined);
    },
  };
}
