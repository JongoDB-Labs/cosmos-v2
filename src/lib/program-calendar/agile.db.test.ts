// @vitest-environment node
//
// The Agile overlay on Program Management's calendar reads sprints, Program
// Increments, releases and work-item due dates across every project in the
// org. Each is a record another API already serves under its own rule, and the
// calendar must not become a way around it:
//
// - a team-restricted project the viewer is not on stays out;
// - an API key limited to some projects reads only those;
// - intervals follow SPRINT_READ and work items ITEM_READ, bit and rules alike;
// - a project named in the request narrows, and never widens.
//
// Every refusal here is paired with someone entitled to the same rows who gets
// them, so no case can pass by the overlay simply returning nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { loadAgileOverlay } from "./agile.server";

const stamp = Math.random().toString(36).slice(2, 8);
const N = {
  secSprint: `sec-sprint-${stamp}`,
  secDue: `sec-due-${stamp}`,
  opnIncrement: `opn-increment-${stamp}`,
  opnSprint: `opn-sprint-${stamp}`,
  opnRelease: `opn-release-${stamp}`,
  opnPhase: `opn-phase-${stamp}`,
  opnBefore: `opn-before-${stamp}`,
  opnEdge: `opn-edge-${stamp}`,
  opnDue: `opn-due-${stamp}`,
  opnDone: `opn-done-${stamp}`,
  opnArchived: `opn-archived-${stamp}`,
  opnLate: `opn-late-${stamp}`,
  xtrSprint: `xtr-sprint-${stamp}`,
  xtrDue: `xtr-due-${stamp}`,
};

const WINDOW = { from: new Date("2027-01-01T00:00:00.000Z"), to: new Date("2027-02-01T00:00:00.000Z") };

let orgId = "";
let sec = "", opn = "", xtr = "";
const user: Record<string, string> = {};
const ROLES = { admin: "ADMIN", insider: "MEMBER", outsider: "MEMBER" } as const;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `agile ${stamp}`, slug: `agile-${stamp}` } })).id;
  const membership: Record<string, string> = {};
  for (const [who, role] of Object.entries(ROLES)) {
    user[who] = (await prisma.user.create({ data: { email: `${who}-${stamp}@agile.test`, displayName: `${who} ${stamp}` } })).id;
    membership[who] = (await prisma.orgMember.create({ data: { orgId, userId: user[who], role, permissions: "0" } })).id;
  }
  sec = (await prisma.project.create({ data: { orgId, name: `Restricted ${stamp}`, key: "SEC", teamScopedAccess: true } })).id;
  opn = (await prisma.project.create({ data: { orgId, name: `Open ${stamp}`, key: "OPN" } })).id;
  xtr = (await prisma.project.create({ data: { orgId, name: `Extra ${stamp}`, key: "XTR" } })).id;
  await prisma.projectMember.create({ data: { projectId: sec, orgMemberId: membership.insider, role: "MEMBER" } });

  const type = await prisma.workItemType.findFirstOrThrow({ where: { orgId: null } });
  let ticket = 0;
  const workItem = async (projectId: string, title: string, dueDate: string, extra: { columnKey?: string; archivedAt?: Date } = {}) =>
    createWorkItemRow(prisma, {
      data: {
        orgId, projectId, ticketNumber: ++ticket, title, columnKey: extra.columnKey ?? "todo",
        workItemTypeId: type.id, createdById: user.admin, dueDate: new Date(dueDate),
        ...(extra.archivedAt ? { archivedAt: extra.archivedAt } : {}),
      },
    }, { actorId: null, source: "SYSTEM" });
  let number = 0;
  const interval = (projectId: string, name: string, intervalKind: "SPRINT" | "PROGRAM_INCREMENT" | "RELEASE" | "PHASE", startDate: string, endDate: string) =>
    prisma.interval.create({
      data: { orgId, projectId, number: ++number, name, intervalKind, startDate: new Date(startDate), endDate: new Date(endDate) },
    });

  for (const projectId of [sec, opn, xtr]) {
    const board = await prisma.board.create({ data: { orgId, projectId, name: "Board", type: "KANBAN" } });
    await seedBoardColumns(prisma, board, [
      { key: "todo", name: "To Do", category: "TODO" },
      { key: "done", name: "Done", category: "DONE" },
    ]);
  }

  await interval(sec, N.secSprint, "SPRINT", "2027-01-04", "2027-01-22");
  await interval(opn, N.opnIncrement, "PROGRAM_INCREMENT", "2027-01-04", "2027-03-26");
  await interval(opn, N.opnSprint, "SPRINT", "2027-01-04", "2027-01-22");
  await interval(opn, N.opnRelease, "RELEASE", "2027-01-29", "2027-01-29");
  await interval(opn, N.opnPhase, "PHASE", "2027-01-04", "2027-01-22");
  // Ends the day before the window opens: covers up to 2027-01-01T00:00, exclusive.
  await interval(opn, N.opnBefore, "SPRINT", "2026-12-14", "2026-12-31");
  // Ends ON the window's first day: that day is inside it.
  await interval(opn, N.opnEdge, "SPRINT", "2026-12-18", "2027-01-01");
  await interval(xtr, N.xtrSprint, "SPRINT", "2027-01-04", "2027-01-22");

  await workItem(sec, N.secDue, "2027-01-11");
  await workItem(opn, N.opnDue, "2027-01-10");
  await workItem(opn, N.opnDone, "2027-01-12", { columnKey: "done" });
  await workItem(opn, N.opnArchived, "2027-01-13", { archivedAt: new Date() });
  await workItem(opn, N.opnLate, "2027-03-02");
  await workItem(xtr, N.xtrDue, "2027-01-14");
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(user) } } }).catch(() => undefined);
});

function ctxFor(who: keyof typeof ROLES, over: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES[who];
  return {
    userId: user[who], orgId, orgRole: role, abacRules: [],
    permissions: RolePermissions[role], basePermissions: RolePermissions[role], ...over,
  };
}

/** Every name the overlay returned, intervals and work items alike. */
async function names(ctx: AuthContext, projectId?: string): Promise<string[]> {
  const p = await loadAgileOverlay(ctx, { ...WINDOW, projectId });
  return [...p.intervals.map((i) => i.name), ...p.due.map((d) => d.title)];
}

const denyOn = (action: string, projectId: string): AbacRule[] =>
  [{ effect: "deny", actions: [action], conditions: [{ attr: "projectId", op: "eq", value: projectId }] }] as AbacRule[];

describe("the Agile overlay shows only the projects the viewer may read", () => {
  it("a team-restricted project stays out for someone not on it", async () => {
    const out = await names(ctxFor("outsider"));
    expect(out).toContain(N.opnSprint);
    expect(out).toContain(N.opnDue);
    expect(out).not.toContain(N.secSprint);
    expect(out).not.toContain(N.secDue);
  });

  it("control: a member of that project gets its sprint and its work item", async () => {
    const out = await names(ctxFor("insider"));
    expect(out).toContain(N.secSprint);
    expect(out).toContain(N.secDue);
  });

  it("naming the restricted project does not open it; its member still gets it by name", async () => {
    expect(await names(ctxFor("outsider"), sec)).toEqual([]);
    const control = await names(ctxFor("insider"), sec);
    expect(control).toContain(N.secSprint);
    expect(control).toContain(N.secDue);
  });

  it("naming a project narrows to it", async () => {
    const out = await names(ctxFor("admin"), opn);
    expect(out).toContain(N.opnSprint);
    expect(out).not.toContain(N.xtrSprint);
    expect(out).not.toContain(N.secSprint);
  });
});

describe("an API key reads only the projects it is limited to", () => {
  // A key's permissions are its scopes; `read` grants these reads.
  const key = (projectScope: string[]) =>
    ctxFor("admin", { isApiKey: true, scopes: ["read"], projectScope, permissions: RolePermissions.MEMBER });

  it("a key limited to one project gets that project's rows and no other's", async () => {
    const out = await names(key([opn]));
    expect(out).toContain(N.opnSprint);
    expect(out).toContain(N.opnDue);
    expect(out).not.toContain(N.xtrSprint);
    expect(out).not.toContain(N.xtrDue);
    expect(out).not.toContain(N.secSprint);
  });

  it("control: limited to the other project, it gets that one instead", async () => {
    const out = await names(key([xtr]));
    expect(out).toContain(N.xtrSprint);
    expect(out).toContain(N.xtrDue);
    expect(out).not.toContain(N.opnSprint);
  });

  it("naming a project outside the key's limit returns nothing for it", async () => {
    expect(await names(key([opn]), xtr)).toEqual([]);
  });
});

describe("each kind follows its own API's permission", () => {
  it("without SPRINT_READ there are no intervals, while due dates still load", async () => {
    const p = await loadAgileOverlay(
      ctxFor("outsider", { permissions: RolePermissions.MEMBER & ~Permission.SPRINT_READ }),
      WINDOW,
    );
    expect(p.intervals).toEqual([]);
    expect(p.due.map((d) => d.title)).toContain(N.opnDue);
  });

  it("without ITEM_READ there are no due dates, while intervals still load", async () => {
    const p = await loadAgileOverlay(
      ctxFor("outsider", { permissions: RolePermissions.MEMBER & ~Permission.ITEM_READ }),
      WINDOW,
    );
    expect(p.due).toEqual([]);
    expect(p.intervals.map((i) => i.name)).toContain(N.opnSprint);
  });

  it("a rule denying SPRINT_READ on one project drops its intervals and keeps its work items", async () => {
    const out = await names(ctxFor("outsider", { abacRules: denyOn("SPRINT_READ", opn) }));
    expect(out).not.toContain(N.opnSprint);
    expect(out).not.toContain(N.opnIncrement);
    expect(out).toContain(N.opnDue);
    expect(out).toContain(N.xtrSprint);
  });

  it("a rule denying ITEM_READ on one project drops its work items and keeps its intervals", async () => {
    const out = await names(ctxFor("outsider", { abacRules: denyOn("ITEM_READ", opn) }));
    expect(out).not.toContain(N.opnDue);
    expect(out).toContain(N.opnSprint);
    expect(out).toContain(N.xtrDue);
  });
});

describe("what the window holds", () => {
  it("Program Increments, sprints and releases, and not other interval kinds", async () => {
    const p = await loadAgileOverlay(ctxFor("admin"), { ...WINDOW, projectId: opn });
    const byName = Object.fromEntries(p.intervals.map((i) => [i.name, i.kind]));
    expect(byName[N.opnIncrement]).toBe("PROGRAM_INCREMENT");
    expect(byName[N.opnSprint]).toBe("SPRINT");
    expect(byName[N.opnRelease]).toBe("RELEASE");
    expect(byName).not.toHaveProperty(N.opnPhase);
  });

  it("an interval ending on the window's first day is in it; one ending the day before is not", async () => {
    const out = await names(ctxFor("admin"), opn);
    expect(out).toContain(N.opnEdge);
    expect(out).not.toContain(N.opnBefore);
  });

  it("due dates inside the window, archived items left out, done items marked", async () => {
    const p = await loadAgileOverlay(ctxFor("admin"), { ...WINDOW, projectId: opn });
    const byTitle = Object.fromEntries(p.due.map((d) => [d.title, d]));
    expect(byTitle[N.opnDue]?.resolved).toBe(false);
    expect(byTitle[N.opnDone]?.resolved).toBe(true);
    expect(byTitle[N.opnDue]?.key).toMatch(/^OPN-\d+$/);
    expect(byTitle).not.toHaveProperty(N.opnArchived);
    expect(byTitle).not.toHaveProperty(N.opnLate);
    expect(p.dueCapped).toBe(false);
  });
});
