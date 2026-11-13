// @vitest-environment node
//
// A server page reads the database directly, so it has to make the same
// decision as the API that serves the same rows. These pages did not, and what
// a server page loads is in the page it sends, whatever the screen then shows:
//
// - Pages under a project relied on the project layout to refuse a non-member.
//   A layout and its page render in parallel, so the page's data was sent
//   anyway, under a "not found" screen.
// - The project PM dashboard checked no permission and no allow/deny rule; its
//   registers' APIs check both.
// - Project settings and import listed boards (and board columns) that belong
//   to a team the viewer is not on.
// - The Org page loaded pending invitations and work roles for every member;
//   their APIs answer only to people who manage members.
// - Saved analytics reports and the template editor loaded with no check.
// - The PM calendar sent deliverables from every project the viewer could see,
//   whatever their analytics access; the schedule and deliverables tabs sent
//   timebox names the intervals API withholds; the vendors tab listed every
//   partner to people without CRM access.
//
// Each page is called as the server calls it, against a real database, and
// what it hands to its client components is searched for the data it should
// have withheld. Every refusal is paired with a viewer who is entitled to the
// same data and gets it, so no case can pass by the page simply being broken.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Suspense, isValidElement } from "react";
import { prisma } from "@/lib/db/client";
import { Permission, RolePermissions, maskToDb } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";
import type { AbacRule } from "@/lib/abac/engine";

const h = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext: async () => h.ctx, getCurrentUser: async () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/internal/require-system-admin", () => ({ requireSystemAdmin: async () => null }));
// Client components are stubs. The page's output still records the PROPS it
// gives them, and those props are exactly what is sent to the browser.
vi.mock("@/components/ui/no-page-access", () => ({ NoPageAccess: () => null }));
vi.mock("@/components/pm-dashboard/pm-dashboard", () => ({ PmDashboard: () => null }));
vi.mock("@/components/projects/project-members-manager", () => ({ ProjectMembersManager: () => null }));
vi.mock("@/components/projects/project-teams-section", () => ({ ProjectTeamsSection: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/projects/[projectKey]/settings/project-settings-client", () => ({
  ProjectSettingsClient: () => null,
}));
vi.mock("@/components/mentions/mentioned-in", () => ({ MentionedIn: () => null }));
vi.mock("@/components/finance/project-fee-terms", () => ({ ProjectFeeTerms: () => null }));
vi.mock("@/components/import/import-wizard", () => ({ ImportWizard: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/team-table", () => ({ TeamTable: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/invite-member-button", () => ({ InviteMemberButton: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/team/account-request-queue", () => ({ AccountRequestQueue: () => null }));
vi.mock("@/components/analytics/reports-manager", () => ({ ReportsManager: () => null }));
vi.mock("@/app/(dashboard)/[orgSlug]/settings/templates/[templateId]/template-editor", () => ({
  TemplateEditor: () => null,
}));

vi.mock("@/components/program-calendar/program-calendar", () => ({ ProgramCalendar: () => null }));
vi.mock("@/components/pm-dashboard/schedule-tracker", () => ({ ScheduleTracker: () => null }));
vi.mock("@/components/pm-dashboard/deliverable-tracker", () => ({ DeliverableTracker: () => null }));
vi.mock("@/components/pm-dashboard/vendor-tracker", () => ({ VendorTracker: () => null }));

import { NoPageAccess } from "@/components/ui/no-page-access";
import CalendarPage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/pm-dashboard/calendar/page";
import SchedulePage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/pm-dashboard/schedule/page";
import DeliverablesPage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/pm-dashboard/deliverables/page";
import VendorsPage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/pm-dashboard/vendors/page";
import PmDashboardPage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/pm-dashboard/page";
import MembersPage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/members/page";
import SettingsPage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/settings/page";
import ImportPage from "@/app/(dashboard)/[orgSlug]/projects/[projectKey]/import/page";
import TeamPage from "@/app/(dashboard)/[orgSlug]/team/page";
import ReportsPage from "@/app/(dashboard)/[orgSlug]/analytics/reports/page";
import TemplateEditorPage from "@/app/(dashboard)/[orgSlug]/settings/templates/[templateId]/page";

const stamp = Math.random().toString(36).slice(2, 8);
const S = {
  secProject: `Secret project ${stamp}`,
  secRisk: `sec-risk-${stamp}`,
  opnRisk: `opn-risk-${stamp}`,
  opnGoal: `opn-goal-${stamp}`,
  sharedBoard: `shared-board-${stamp}`,
  teamBoard: `team-board-${stamp}`,
  teamColumn: `team-column-${stamp}`,
  invitee: `invitee-${stamp}@example.com`,
  workRole: `work-role-${stamp}`,
  report: `report-${stamp}`,
  template: `template-marker-${stamp}`,
  opnDeliverable: `opn-deliverable-${stamp}`,
  secDeliverable: `sec-deliverable-${stamp}`,
  increment: `increment-${stamp}`,
  sprint: `sprint-${stamp}`,
  partner: `partner-${stamp}`,
};

type Role = "ADMIN" | "MEMBER" | "VIEWER" | "GUEST" | "BILLING_ADMIN";
const ROLES: Record<string, Role> = {
  admin: "ADMIN", insider: "MEMBER", outsider: "MEMBER", viewer: "VIEWER", guest: "GUEST", billing: "BILLING_ADMIN",
};
let orgId = "", orgSlug = "", sec = "", opn = "", templateId = "";
const user: Record<string, string> = {};

beforeAll(async () => {
  orgSlug = `pg-${stamp}`;
  orgId = (await prisma.organization.create({ data: { name: `pg ${stamp}`, slug: orgSlug } })).id;
  const membership: Record<string, string> = {};
  for (const [who, role] of Object.entries(ROLES)) {
    user[who] = (await prisma.user.create({ data: { email: `${who}-${stamp}@pg.test`, displayName: `${who} ${stamp}` } })).id;
    membership[who] = (await prisma.orgMember.create({ data: { orgId, userId: user[who], role, permissions: "0" } })).id;
  }

  // SEC is limited to its members; the insider is one, the outsider is not.
  sec = (await prisma.project.create({ data: { orgId, name: S.secProject, key: "SEC", teamScopedAccess: true } })).id;
  opn = (await prisma.project.create({ data: { orgId, name: `Open ${stamp}`, key: "OPN" } })).id;
  await prisma.projectMember.create({ data: { projectId: sec, orgMemberId: membership.insider, role: "MEMBER" } });
  const insiderOnOpen = await prisma.projectMember.create({
    data: { projectId: opn, orgMemberId: membership.insider, role: "MEMBER" },
  });
  await prisma.risk.create({ data: { orgId, projectId: sec, code: "R-1", title: S.secRisk } });
  await prisma.risk.create({ data: { orgId, projectId: opn, code: "R-2", title: S.opnRisk } });
  await prisma.goal.create({ data: { orgId, projectId: opn, title: S.opnGoal } });
  await prisma.deliverable.create({ data: { orgId, projectId: opn, code: "D-1", title: S.opnDeliverable } });
  await prisma.deliverable.create({ data: { orgId, projectId: sec, code: "D-2", title: S.secDeliverable } });
  const span = { startDate: new Date("2026-01-01"), endDate: new Date("2026-03-31") };
  await prisma.interval.create({ data: { orgId, projectId: opn, number: 1, name: S.increment, intervalKind: "PROGRAM_INCREMENT", ...span } });
  await prisma.interval.create({ data: { orgId, projectId: opn, number: 2, name: S.sprint, intervalKind: "SPRINT", ...span } });
  await prisma.partner.create({ data: { orgId, name: S.partner } });

  // On the open project: one board for everyone, one for a team the insider is on.
  const team = await prisma.team.create({ data: { orgId, projectId: opn, name: `Team ${stamp}` } });
  await prisma.teamMember.create({ data: { teamId: team.id, projectMemberId: insiderOnOpen.id } });
  await prisma.board.create({
    data: {
      orgId, projectId: opn, name: S.sharedBoard, slug: "shared", type: "KANBAN",
      columns: { create: [{ key: "todo", name: "To do" }] },
    },
  });
  await prisma.board.create({
    data: {
      orgId, projectId: opn, teamId: team.id, name: S.teamBoard, slug: "team", type: "KANBAN",
      columns: { create: [{ key: "team-col", name: S.teamColumn }] },
    },
  });

  await prisma.invitation.create({
    data: { orgId, email: S.invitee, role: "ADMIN", expiresAt: new Date(Date.now() + 7 * 864e5) },
  });
  const workRole = await prisma.workRole.create({
    data: { orgId, key: `wr-${stamp}`, name: S.workRole, grants: maskToDb(Permission.ITEM_READ) },
  });
  await prisma.orgMemberWorkRole.create({ data: { orgMemberId: membership.insider, workRoleId: workRole.id } });
  await prisma.savedReport.create({ data: { orgId, createdById: user.admin, name: S.report, type: "velocity" } });
  templateId = (await prisma.projectTemplate.create({
    data: { orgId, slug: `tpl-${stamp}`, sector: "software", name: `Template ${stamp}`, defaultConfig: { marker: S.template } },
  })).id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: Object.values(user) } } }).catch(() => undefined);
});

/** Sign in as one of the fixture's people, with their role's permissions. */
function as(who: keyof typeof ROLES, over: Partial<AuthContext> = {}) {
  const role = ROLES[who];
  const ctx: AuthContext = {
    userId: user[who], orgId, orgRole: role, abacRules: [],
    permissions: RolePermissions[role], basePermissions: RolePermissions[role], ...over,
  };
  h.ctx = ctx;
}

type Element = { type: unknown; props: Record<string, unknown> };
/** The page's output, with a Suspense boundary opened the way the server opens it. */
async function render(page: unknown): Promise<unknown> {
  const el = (await page) as Element;
  if (isValidElement(el) && el.type === Suspense) {
    const child = (el as Element).props.children as Element;
    return (child.type as (p: unknown) => Promise<unknown>)(child.props);
  }
  return el;
}
/** Everything the output hands on, serialised: what reaches the browser. */
const sent = (out: unknown) => JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? String(v) : v));
/** Whether the output (at any depth) is the refusal screen. */
function refuses(out: unknown): boolean {
  if (!isValidElement(out)) return false;
  const el = out as Element;
  if (el.type === NoPageAccess) return true;
  const kids = ([] as unknown[]).concat(el.props.children ?? []);
  return kids.some(refuses);
}
const project = (projectKey: string) => ({ params: Promise.resolve({ orgSlug, projectKey }) });
const org = () => ({ params: Promise.resolve({ orgSlug }) });

describe("pages under a project check visibility themselves", () => {
  it("PM dashboard: a non-member of a limited project gets nothing; a member gets its risks", async () => {
    as("outsider");
    await expect(render(PmDashboardPage(project("SEC")))).rejects.toThrow("NEXT_NOT_FOUND");
    as("insider");
    expect(sent(await render(PmDashboardPage(project("SEC"))))).toContain(S.secRisk);
  });

  it("members: the same", async () => {
    as("outsider");
    await expect(render(MembersPage(project("SEC")))).rejects.toThrow("NEXT_NOT_FOUND");
    as("insider");
    expect(sent(await render(MembersPage(project("SEC"))))).toContain(S.secProject);
  });
});

describe("the project PM dashboard asks what its registers' APIs ask", () => {
  it("a role without ANALYTICS_READ is refused, and none of the registers are sent", async () => {
    as("billing");
    const out = await render(PmDashboardPage(project("OPN")));
    expect(refuses(out)).toBe(true);
    expect(sent(out)).not.toContain(S.opnRisk);
    as("outsider");
    const control = await render(PmDashboardPage(project("OPN")));
    expect(refuses(control)).toBe(false);
    expect(sent(control)).toContain(S.opnRisk);
  });

  it("a rule denying ANALYTICS_READ on this project refuses it, as the API does", async () => {
    const deny: AbacRule = { effect: "deny", actions: ["ANALYTICS_READ"], conditions: [{ attr: "projectId", op: "eq", value: opn }] };
    as("outsider", { abacRules: [deny] });
    const out = await render(PmDashboardPage(project("OPN")));
    expect(refuses(out)).toBe(true);
    expect(sent(out)).not.toContain(S.opnRisk);
  });

  it("goals need OKR_READ: without it the registers load and the goals do not", async () => {
    as("outsider", { permissions: RolePermissions.MEMBER & ~Permission.OKR_READ });
    const out = sent(await render(PmDashboardPage(project("OPN"))));
    expect(out).toContain(S.opnRisk);
    expect(out).not.toContain(S.opnGoal);
    as("outsider");
    expect(sent(await render(PmDashboardPage(project("OPN"))))).toContain(S.opnGoal);
  });
});

describe("project settings and import list only the boards the viewer may see", () => {
  it("settings: a team's board is not named to someone outside the team", async () => {
    as("outsider");
    const out = sent(await render(SettingsPage(project("OPN"))));
    expect(out).toContain(S.sharedBoard);
    expect(out).not.toContain(S.teamBoard);
    as("insider");
    expect(sent(await render(SettingsPage(project("OPN"))))).toContain(S.teamBoard);
  });

  it("import: nor are its columns offered", async () => {
    as("outsider");
    expect(sent(await render(ImportPage(project("OPN"))))).not.toContain(S.teamColumn);
    as("insider");
    expect(sent(await render(ImportPage(project("OPN"))))).toContain(S.teamColumn);
  });
});

describe("the Org page sends invitations and work roles only to people who manage members", () => {
  it("a viewer gets the member list, and no invitee or work role", async () => {
    as("viewer");
    const out = sent(await render(TeamPage(org())));
    expect(out).toContain(`insider-${stamp}@pg.test`);
    expect(out).not.toContain(S.invitee);
    expect(out).not.toContain(S.workRole);
  });

  it("an admin gets both", async () => {
    as("admin");
    const out = sent(await render(TeamPage(org())));
    expect(out).toContain(S.invitee);
    expect(out).toContain(S.workRole);
  });
});

describe("saved reports and the template editor check before they load", () => {
  it("reports: refused without ANALYTICS_READ, and no report is sent", async () => {
    for (const who of ["guest", "billing"] as const) {
      as(who);
      const out = await render(ReportsPage(org()));
      expect(refuses(out), who).toBe(true);
      expect(sent(out), who).not.toContain(S.report);
    }
    as("viewer");
    expect(sent(await render(ReportsPage(org())))).toContain(S.report);
  });

  it("template editor: refused without the templates permission; a member gets the template", async () => {
    const at = { params: Promise.resolve({ orgSlug, templateId }) };
    as("guest");
    const out = await render(TemplateEditorPage(at));
    expect(refuses(out)).toBe(true);
    expect(sent(out)).not.toContain(S.template);
    as("outsider");
    expect(sent(await render(TemplateEditorPage(at)))).toContain(S.template);
  });
});

describe("the PM calendar asks what the deliverables API asks, for every project it rolls up", () => {
  const denyOn = (action: string, projectId: string): AbacRule[] =>
    [{ effect: "deny", actions: [action], conditions: [{ attr: "projectId", op: "eq", value: projectId }] }] as AbacRule[];

  it("a role without ANALYTICS_READ is refused, and no deliverable is sent", async () => {
    as("billing");
    const out = await render(CalendarPage(project("OPN")));
    expect(refuses(out)).toBe(true);
    expect(sent(out)).not.toContain(S.opnDeliverable);
    as("viewer");
    expect(sent(await render(CalendarPage(project("OPN"))))).toContain(S.opnDeliverable);
  });

  it("a rule denying ANALYTICS_READ on another project drops that project's deliverables", async () => {
    as("insider");
    const all = sent(await render(CalendarPage(project("OPN"))));
    expect(all).toContain(S.opnDeliverable);
    expect(all).toContain(S.secDeliverable);
    as("insider", { abacRules: denyOn("ANALYTICS_READ", sec) });
    const out = sent(await render(CalendarPage(project("OPN"))));
    expect(out).toContain(S.opnDeliverable);
    expect(out).not.toContain(S.secDeliverable);
  });

  it("a rule denying ANALYTICS_READ on this project refuses the page", async () => {
    as("insider", { abacRules: denyOn("ANALYTICS_READ", opn) });
    const out = await render(CalendarPage(project("OPN")));
    expect(refuses(out)).toBe(true);
    expect(sent(out)).not.toContain(S.opnDeliverable);
  });
});

describe("the schedule, deliverables and vendors tabs send only what their APIs would", () => {
  const denyOn = (action: string, projectId: string): AbacRule[] =>
    [{ effect: "deny", actions: [action], conditions: [{ attr: "projectId", op: "eq", value: projectId }] }] as AbacRule[];
  const pages = [
    ["schedule's program increments", SchedulePage, () => S.increment],
    ["deliverables' sprints", DeliverablesPage, () => S.sprint],
  ] as const;

  for (const [what, Page, name] of pages) {
    it(`${what}: not without SPRINT_READ, or with it denied on the project; sent to a viewer`, async () => {
      as("billing");
      expect(sent(await render(Page(project("OPN"))))).not.toContain(name());
      as("insider", { abacRules: denyOn("SPRINT_READ", opn) });
      expect(sent(await render(Page(project("OPN"))))).not.toContain(name());
      as("viewer");
      expect(sent(await render(Page(project("OPN"))))).toContain(name());
    });
  }

  it("vendors: partners only for somebody with CRM_READ", async () => {
    as("billing");
    expect(sent(await render(VendorsPage(project("OPN"))))).not.toContain(S.partner);
    as("viewer");
    expect(sent(await render(VendorsPage(project("OPN"))))).toContain(S.partner);
  });
});
