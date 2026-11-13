// @vitest-environment node
//
// The assistant's people tools against the project-members and team routes, for
// the SAME real actor, in a real database (e2e DB). Each write case runs the
// route handler (only `getAuthContext` is mocked, to hand it the actor's own
// AuthContext) and the tool, and asserts they agree: both allow, or both refuse
// and nothing is written.
//
// The reads are held to the caller's own access: a person's projects, teams and
// open work are shown only where the CALLER may read.
//
// Own org and own users; the seeded ones are never touched. Every refusal has a
// control beside it showing the same call succeeding for someone it should.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import type { OrgRole } from "@prisma/client";

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));

import { prisma } from "@/lib/db/client";
import { Permission, maskToDb } from "@/lib/rbac/permissions";
import { memberToolCtx } from "@/lib/testing/tool-auth";
import { createFixtureWorkItem, ensureFixtureStatuses } from "@/lib/testing/db-fixtures";
import type { ToolContext } from "./_ctx";
import {
  addProjectMember,
  addTeamMemberTool,
  getPerson,
  listProjectMembers,
  removeProjectMemberTool,
  removeTeamMemberTool,
} from "./people";
import { listOrgMembers } from "./compliance";
import { GET as getMembersRoute, PUT as putMemberRoute, DELETE as deleteMemberRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/members/route";
import { POST as addTeamMemberRoute, DELETE as teamDeleteRoute } from "@/app/api/v1/orgs/[orgId]/projects/[projectId]/teams/[teamId]/route";

type Out = Record<string, unknown> & { error?: string };
const call = async (fn: (i: Record<string, unknown>, c: ToolContext) => Promise<unknown>, input: Record<string, unknown>, ctx: ToolContext) =>
  (await fn(input, ctx)) as Out;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userIds: string[] = [];
let orgId = "";
/** An open project: every org member reads it. */
let open = "";
/** A team-scoped project: only its members read it. */
let closed = "";
let teamId = "";
let owner: ToolContext, admin: ToolContext, manager: ToolContext, member: ToolContext, delegate: ToolContext;
/** The person looked up: on both projects, with an open item in each. */
let subjectId = "", subjectOm = "";
/** A person on no project yet, added and removed by the specs. */
let newcomerId = "", newcomerOm = "";

async function user(name: string) {
  const u = await prisma.user.create({ data: { email: `${name}-${stamp}@example.com`, displayName: `${name} ${stamp}` } });
  userIds.push(u.id);
  return u.id;
}

/** Call a route as `actor`; returns the HTTP status. */
async function asRest(
  actor: ToolContext,
  handler: (r: NextRequest, c: never) => Promise<Response>,
  params: Record<string, string>,
  method: string,
  body?: unknown,
  search = "",
) {
  getAuthContext.mockResolvedValue(actor.auth);
  const res = await handler(
    new NextRequest(`http://localhost/x${search}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve({ orgId, ...params }) } as never,
  );
  return res.status;
}
const ok = (status: number) => status >= 200 && status < 300;
const scoped = (ctx: ToolContext, projectScope: string[]): ToolContext => ({ ...ctx, auth: { ...ctx.auth!, projectScope } });
/** The same actor through an API key scoped to `projectScope` (a key's roster is narrowed; a session's is not). */
const viaKey = (ctx: ToolContext, projectScope: string[]): ToolContext => ({
  ...ctx,
  auth: { ...ctx.auth!, projectScope, isApiKey: true },
});

const onProject = (projectId: string, orgMemberId: string) =>
  prisma.projectMember.findFirst({ where: { projectId, orgMemberId }, select: { id: true, role: true } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `people ${stamp}`, slug: `people-${stamp}` } })).id;
  const om = async (userId: string, role: OrgRole, permissions?: bigint) =>
    (await prisma.orgMember.create({ data: { orgId, userId, role, ...(permissions ? { permissions: maskToDb(permissions) } : {}) } })).id;

  const ownerId = await user("owner");
  const adminId = await user("admin");
  const managerId = await user("manager");
  const memberId = await user("member");
  const delegateId = await user("delegate");
  subjectId = await user("subject");
  newcomerId = await user("newcomer");
  await om(ownerId, "OWNER");
  await om(adminId, "ADMIN");
  const managerOm = await om(managerId, "MEMBER");
  const memberOm = await om(memberId, "MEMBER");
  // Holds the DELEGABLE project-manage bit org-wide, and manages nothing: the
  // roster routes take the manager ROLE, not that bit.
  const delegateOm = await om(delegateId, "MEMBER", Permission.PROJECT_MANAGE);
  subjectOm = await om(subjectId, "MEMBER");
  newcomerOm = await om(newcomerId, "MEMBER");

  const k = stamp.slice(-4).toUpperCase();
  open = (await prisma.project.create({ data: { orgId, name: "Open", key: `PPA${k}` } })).id;
  closed = (await prisma.project.create({ data: { orgId, name: "Closed", key: `PPB${k}`, teamScopedAccess: true } })).id;

  const pm = (projectId: string, orgMemberId: string, role: "MANAGER" | "MEMBER") =>
    prisma.projectMember.create({ data: { projectId, orgMemberId, role } });
  await pm(open, managerOm, "MANAGER");
  await pm(open, memberOm, "MEMBER");
  await pm(open, delegateOm, "MEMBER");
  const subjectOnOpen = await pm(open, subjectOm, "MEMBER");
  await pm(closed, subjectOm, "MEMBER");
  await pm(closed, managerOm, "MANAGER");

  const team = await prisma.team.create({ data: { orgId, projectId: open, name: "Platform" } });
  teamId = team.id;
  await prisma.teamMember.create({ data: { teamId, projectMemberId: subjectOnOpen.id } });

  // One open item for the subject in each project.
  const typeId = (await prisma.workItemType.create({ data: { orgId, key: `task-${stamp}`, name: "Task" } })).id;
  for (const projectId of [open, closed]) {
    await ensureFixtureStatuses(projectId, ["todo", "done"], { done: "DONE" });
    const item = await createFixtureWorkItem({
      orgId, projectId, workItemTypeId: typeId, createdById: ownerId,
      title: projectId === open ? "open-project item" : "closed-project item", columnKey: "todo",
    });
    await prisma.workItem.update({ where: { id: item.id }, data: { assigneeId: subjectId } });
  }

  owner = await memberToolCtx(orgId, ownerId);
  admin = await memberToolCtx(orgId, adminId);
  manager = await memberToolCtx(orgId, managerId);
  member = await memberToolCtx(orgId, memberId);
  delegate = await memberToolCtx(orgId, delegateId);
}, 120_000);

afterAll(async () => {
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
});

describe("people tools match the roster routes (e2e DB)", () => {
  it("the fixture is what it claims", () => {
    const has = (c: ToolContext, bit: bigint) => (c.auth!.permissions & bit) === bit;
    expect(has(delegate, Permission.PROJECT_MANAGE)).toBe(true);
    expect(has(member, Permission.PROJECT_MANAGE)).toBe(false);
    expect(member.auth!.orgRole).toBe("MEMBER");
    expect(admin.auth!.orgRole).toBe("ADMIN");
  });

  it("a plain member may not add someone to a project, through either door", async () => {
    const rest = await asRest(member, putMemberRoute, { projectId: open }, "PUT", { orgMemberId: newcomerOm, role: "MEMBER" });
    const tool = await call(addProjectMember, { projectId: open, userId: newcomerId }, member);
    expect(rest).toBe(403);
    expect(tool.error).toMatch(/project manager or an org admin/);
    expect(await onProject(open, newcomerOm)).toBeNull();
  });

  it("nor may a holder of the delegable PROJECT_MANAGE bit who manages nothing", async () => {
    const rest = await asRest(delegate, putMemberRoute, { projectId: open }, "PUT", { orgMemberId: newcomerOm, role: "MANAGER" });
    const tool = await call(addProjectMember, { projectId: open, userId: newcomerId, role: "MANAGER" }, delegate);
    expect(rest).toBe(403);
    expect(tool.error).toMatch(/project manager or an org admin/);
    expect(await onProject(open, newcomerOm)).toBeNull();
  });

  it("the project's manager adds and removes through both, and so does an org admin", async () => {
    expect(await asRest(manager, putMemberRoute, { projectId: open }, "PUT", { orgMemberId: newcomerOm, role: "VIEWER" })).toBe(200);
    expect((await onProject(open, newcomerOm))?.role).toBe("VIEWER");
    expect(ok(await asRest(manager, deleteMemberRoute, { projectId: open }, "DELETE", { orgMemberId: newcomerOm }))).toBe(true);
    expect(await onProject(open, newcomerOm)).toBeNull();

    const added = await call(addProjectMember, { projectId: open, userId: newcomerId, role: "LEAD" }, manager);
    expect(added).toMatchObject({ added: true, member: { projectId: open, userId: newcomerId, role: "LEAD" } });
    expect((await onProject(open, newcomerOm))?.role).toBe("LEAD");
    expect(await call(removeProjectMemberTool, { projectId: open, userId: newcomerId }, admin)).toMatchObject({ removed: true });
    expect(await onProject(open, newcomerOm)).toBeNull();
  });

  it("a key scoped to another project manages nothing here, through either door", async () => {
    const key = scoped(manager, [closed]);
    const rest = await asRest(key, putMemberRoute, { projectId: open }, "PUT", { orgMemberId: newcomerOm, role: "MEMBER" });
    const tool = await call(addProjectMember, { projectId: open, userId: newcomerId }, key);
    expect(ok(rest)).toBe(false);
    expect(tool).toEqual({ error: "Project not found" });
    expect(await onProject(open, newcomerOm)).toBeNull();

    // Control: the same manager, scoped to this project, is admitted.
    const inScope = await call(addProjectMember, { projectId: open, userId: newcomerId }, scoped(manager, [open]));
    expect(inScope).toMatchObject({ added: true });
    await prisma.projectMember.deleteMany({ where: { projectId: open, orgMemberId: newcomerOm } });
  });

  // An org ADMIN is the case a role break-glass placed before the project
  // ceiling would let through: the manager above is a MEMBER, so it cannot
  // tell "the ceiling held" from "the ceiling was never asked".
  it("an org admin limited to another project manages nothing here either, through either door", async () => {
    for (const actor of [scoped(admin, [closed]), viaKey(admin, [closed])]) {
      const rest = await asRest(actor, putMemberRoute, { projectId: open }, "PUT", { orgMemberId: newcomerOm, role: "MEMBER" });
      const tool = await call(addProjectMember, { projectId: open, userId: newcomerId }, actor);
      const restDel = await asRest(actor, deleteMemberRoute, { projectId: open }, "DELETE", { orgMemberId: subjectOm });
      const toolDel = await call(removeProjectMemberTool, { projectId: open, userId: subjectId }, actor);
      expect(ok(rest)).toBe(false);
      expect(tool).toEqual({ error: "Project not found" });
      expect(ok(restDel)).toBe(false);
      expect(toolDel).toEqual({ error: "Project not found" });
      expect(await onProject(open, newcomerOm)).toBeNull();
      expect(await onProject(open, subjectOm)).not.toBeNull();
    }

    // Control: the same admin, limited to THIS project, is admitted.
    const inScope = await call(addProjectMember, { projectId: open, userId: newcomerId }, scoped(admin, [open]));
    expect(inScope).toMatchObject({ added: true });
    await prisma.projectMember.deleteMany({ where: { projectId: open, orgMemberId: newcomerOm } });
  });

  it("the project's last manager cannot be removed or demoted, through either door", async () => {
    const LAST = "This is the project's only manager. Make someone else a manager first.";
    const managerOm = (await prisma.orgMember.findFirstOrThrow({ where: { orgId, userId: manager.userId } })).id;
    expect(await prisma.projectMember.count({ where: { projectId: open, role: "MANAGER" } })).toBe(1);

    expect(await asRest(owner, putMemberRoute, { projectId: open }, "PUT", { orgMemberId: managerOm, role: "MEMBER" })).toBe(409);
    expect(await call(addProjectMember, { projectId: open, userId: manager.userId, role: "MEMBER" }, owner)).toEqual({ error: LAST });
    expect(await asRest(manager, deleteMemberRoute, { projectId: open }, "DELETE", { orgMemberId: managerOm })).toBe(409);
    expect(await call(removeProjectMemberTool, { projectId: open, userId: manager.userId }, owner)).toEqual({ error: LAST });
    expect((await onProject(open, managerOm))?.role).toBe("MANAGER");

    // Control: with a second manager, either may step down, through both doors.
    await prisma.projectMember.create({ data: { projectId: open, orgMemberId: newcomerOm, role: "MANAGER" } });
    expect(await asRest(owner, putMemberRoute, { projectId: open }, "PUT", { orgMemberId: managerOm, role: "LEAD" })).toBe(200);
    expect((await onProject(open, managerOm))?.role).toBe("LEAD");
    await prisma.projectMember.update({ where: { projectId_orgMemberId: { projectId: open, orgMemberId: managerOm } }, data: { role: "MANAGER" } });
    expect(await call(removeProjectMemberTool, { projectId: open, userId: newcomerId }, owner)).toMatchObject({ removed: true });
    expect(await onProject(open, newcomerOm)).toBeNull();
    expect((await onProject(open, managerOm))?.role).toBe("MANAGER");
  });

  it("team membership: a member is refused through both, the manager adds and removes through both", async () => {
    const newcomerPm = await prisma.projectMember.create({ data: { projectId: open, orgMemberId: newcomerOm, role: "MEMBER" } });
    const onTeam = () => prisma.teamMember.count({ where: { teamId, projectMemberId: newcomerPm.id } });

    expect(await asRest(member, addTeamMemberRoute, { projectId: open, teamId }, "POST", { projectMemberId: newcomerPm.id })).toBe(403);
    expect(await call(addTeamMemberTool, { projectId: open, teamId, userId: newcomerId }, member)).toEqual({
      error: "You must be a project manager or an org admin to change its teams.",
    });
    expect(await call(addTeamMemberTool, { projectId: open, teamId, userId: newcomerId }, delegate)).toEqual({
      error: "You must be a project manager or an org admin to change its teams.",
    });
    expect(await onTeam()).toBe(0);

    expect(await call(addTeamMemberTool, { projectId: open, teamId, userId: newcomerId }, manager)).toMatchObject({ added: true });
    expect(await onTeam()).toBe(1);
    expect(await call(removeTeamMemberTool, { projectId: open, teamId, userId: newcomerId }, member)).toEqual({
      error: "You must be a project manager or an org admin to change its teams.",
    });
    expect(await onTeam()).toBe(1);
    expect(ok(await asRest(manager, teamDeleteRoute, { projectId: open, teamId }, "DELETE", undefined, `?projectMemberId=${newcomerPm.id}`))).toBe(true);
    expect(await onTeam()).toBe(0);
    expect(ok(await asRest(manager, addTeamMemberRoute, { projectId: open, teamId }, "POST", { projectMemberId: newcomerPm.id }))).toBe(true);
    expect(await call(removeTeamMemberTool, { projectId: open, teamId, userId: newcomerId }, manager)).toMatchObject({ removed: true });
    expect(await onTeam()).toBe(0);

    await prisma.projectMember.delete({ where: { id: newcomerPm.id } });
  });

  it("a team member must already be on the project", async () => {
    expect((await call(addTeamMemberTool, { projectId: open, teamId, userId: newcomerId }, manager)).error).toMatch(
      /not a member of this project/,
    );
  });
});

describe("reading people is held to the caller's access", () => {
  it("list_project_members: a project the caller cannot open reads as not found", async () => {
    expect(await call(listProjectMembers, { projectId: closed }, member)).toEqual({ error: "Project not found" });
    // Control: the owner reads its roster, and the member reads the open one's.
    const ownerView = await call(listProjectMembers, { projectId: closed }, owner);
    expect((ownerView.members as { userId: string }[]).map((m) => m.userId)).toContain(subjectId);
    const openView = await call(listProjectMembers, { projectId: open }, member);
    expect((openView.members as { userId: string; teamIds: string[] }[]).find((m) => m.userId === subjectId)?.teamIds).toEqual([teamId]);
  });

  it("list_project_members discloses as GET /projects/:id/members does: an email only with members:read", async () => {
    type Row = { userId: string; email?: string };
    const both = async (actor: ToolContext) => {
      const tool = (await call(listProjectMembers, { projectId: open }, actor)).members as Row[];
      getAuthContext.mockResolvedValue(actor.auth);
      const res = await getMembersRoute(new NextRequest("http://localhost/x"), { params: Promise.resolve({ orgId, projectId: open }) } as never);
      expect(res.status).toBe(200);
      return { tool, rest: (await res.json()) as Row[] };
    };
    const ids = (rows: Row[]) => rows.map((r) => r.userId).sort();

    const key = viaKey(manager, [open]);
    const without = await both(key);
    expect(ids(without.tool)).toEqual(ids(without.rest));
    expect(without.tool.length).toBeGreaterThan(0);
    expect(without.rest.some((r) => r.email !== undefined)).toBe(false);
    expect(without.tool.some((r) => r.email !== undefined)).toBe(false);

    // Control: the same key holding members:read gets the emails, through both.
    const reader: ToolContext = { ...key, auth: { ...key.auth!, scopes: ["members:read"] } };
    const withRead = await both(reader);
    expect(withRead.rest.every((r) => typeof r.email === "string")).toBe(true);
    expect(withRead.tool.every((r) => typeof r.email === "string")).toBe(true);

    // get_person follows GET /members' rule the same way.
    const person = async (actor: ToolContext) => ((await call(getPerson, { userId: subjectId }, actor)).person as Row);
    expect((await person(key)).email).toBeUndefined();
    expect(typeof (await person(reader)).email).toBe("string");
  });

  it("get_person shows a member only the projects, teams and open work the caller can read", async () => {
    type Person = {
      projects: { projectId: string }[];
      teams: { teamId: string }[];
      assignments: { projectId: string; title: string }[];
    };
    const asMember = (await call(getPerson, { userId: subjectId }, member)) as unknown as Person;
    expect(asMember.projects.map((p) => p.projectId)).toEqual([open]);
    expect(asMember.teams.map((t) => t.teamId)).toEqual([teamId]);
    expect(asMember.assignments.map((i) => i.title)).toEqual(["open-project item"]);

    // Control: the owner reads both projects, so sees both, and both items.
    const asOwner = (await call(getPerson, { userId: subjectId }, owner)) as unknown as Person;
    expect(asOwner.projects.map((p) => p.projectId).sort()).toEqual([open, closed].sort());
    expect(asOwner.assignments.map((i) => i.title).sort()).toEqual(["closed-project item", "open-project item"]);
  });

  it("get_person: a key scoped to a project the person is not on cannot look them up", async () => {
    // The roster a scoped key sees through GET /members is the people on its
    // projects; the newcomer is on none.
    expect((await call(getPerson, { userId: newcomerId }, viaKey(manager, [closed]))).error).toMatch(/not a member of this organization/);
    // Controls: the same key does see someone on its project, and the same
    // person through a browser session sees the newcomer.
    expect((await call(getPerson, { userId: subjectId }, viaKey(manager, [closed]))).error).toBeUndefined();
    expect((await call(getPerson, { userId: newcomerId }, manager)).error).toBeUndefined();
  });

  it("list_org_members finds a person by name", async () => {
    const found = await call(listOrgMembers, { query: `subject ${stamp}` }, member);
    expect((found.members as { userId: string }[]).map((m) => m.userId)).toEqual([subjectId]);
    // Control: without a query the roster is everyone.
    const all = await call(listOrgMembers, {}, member);
    expect((all.members as unknown[]).length).toBeGreaterThanOrEqual(7);
  });
});
