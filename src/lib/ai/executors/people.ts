import { z } from "zod";
import { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { memberDisclosure } from "@/lib/members/scoped-roster.server";
import { executeCql } from "@/lib/query/execute.server";
import { CQL_VERSION, type CqlQuery } from "@/lib/query/ast";
import { cqlEnabled } from "@/lib/query/flag";
import {
  addTeamMember,
  removeProjectMember,
  removeTeamMember,
  requireRosterManage,
  setProjectMember,
} from "@/lib/projects/membership.server";
import { assertPermission, assertProjectRead, loadAuthContext, serviceRefusal, type ToolContext } from "./_ctx";

/**
 * People: who someone is in this org, what they work on, and who is on which
 * project and team.
 *
 * Reads mirror `GET /members` (the org roster, narrowed for a project-scoped
 * key) and `GET /projects/:id/members` (a project's roster, behind
 * `requireProjectRead`). A person's projects, teams and assignments are shown
 * only inside the projects the CALLER may read; someone else's work on a
 * project the caller cannot open is not theirs to see.
 *
 * Writes call the membership service the project-members and team routes call
 * (`membership.server.ts`), so the authority is the routes' own: an org owner or
 * admin, or a MANAGER of the project. Org membership and org roles are not
 * here: the API keeps those to org administrators.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

/** The org member a userId names, or null when it names no one in this org. */
async function orgMemberOf(orgId: string, userId: string) {
  return prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { id: true, userId: true, role: true, user: { select: { displayName: true, email: true } } },
  });
}

// ── list_project_members ────────────────────────────────────────────────────

const projectSchema = z.object({ projectId: z.string().uuid() });

export async function listProjectMembers(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_READ);
  if (denied) return denied;
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId } = parsed.data;

  // GET /projects/:id/members' own gate.
  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  // And its disclosure: the caller's roster ceiling, and an email only with
  // members:read (both bind API keys; a session sees everyone's).
  const people = await memberDisclosure(auth);

  // Explicit select: OrgMember.permissions is a permission mask and never
  // rides out in a reply.
  const members = await prisma.projectMember.findMany({
    where: { projectId },
    select: {
      id: true,
      role: true,
      orgMember: { select: { userId: true, user: { select: { displayName: true, email: true, isBot: true } } } },
      teamMembers: { select: { teamId: true, isLead: true } },
    },
  });
  const shown = members.filter((m) => people.inRoster(m.orgMember.userId));
  return {
    count: shown.length,
    members: shown.map((m) => ({
      projectMemberId: m.id,
      userId: m.orgMember.userId,
      name: m.orgMember.user.displayName,
      ...(people.emails && { email: m.orgMember.user.email }),
      role: m.role,
      isBot: m.orgMember.user.isBot,
      teamIds: m.teamMembers.map((t) => t.teamId),
    })),
  };
}

// ── get_person ──────────────────────────────────────────────────────────────

const personSchema = z.object({
  userId: z.string().uuid(),
  assignmentLimit: z.number().int().min(1).max(50).optional(),
});

export async function getPerson(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ORG_READ);
  if (denied) return denied;
  const parsed = personSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { userId, assignmentLimit } = parsed.data;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };

  // What GET /members would show this caller: everyone for a session, the
  // scoped projects' people for a project-scoped key, and an email only with
  // members:read.
  const people = await memberDisclosure(auth);
  const person = await orgMemberOf(ctx.orgId, userId);
  if (!person || !people.inRoster(userId)) {
    return { error: "That person is not a member of this organization. Look them up with list_org_members." };
  }

  // Their projects and teams, only where the CALLER may read.
  const readable = await getReadableProjectIds(auth);
  const memberships = await prisma.projectMember.findMany({
    where: { orgMemberId: person.id, projectId: { in: readable } },
    select: {
      role: true,
      project: { select: { id: true, key: true, name: true, archived: true } },
      teamMembers: { select: { isLead: true, team: { select: { id: true, name: true } } } },
    },
    orderBy: { project: { name: "asc" } },
  });

  const base = {
    person: { userId, name: person.user.displayName, ...(people.emails && { email: person.user.email }), role: person.role },
    projects: memberships.map((m) => ({
      projectId: m.project.id, key: m.project.key, name: m.project.name, archived: m.project.archived, role: m.role,
    })),
    teams: memberships.flatMap((m) =>
      m.teamMembers.map((t) => ({ teamId: t.team.id, name: t.team.name, projectId: m.project.id, isLead: t.isLead })),
    ),
  };

  // Open assignments through the Issues list's own engine, as the caller: the
  // same readable projects, classification and team rules.
  const org = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { settings: true } });
  if (!org || !cqlEnabled(org.settings)) {
    return {
      ...base,
      openAssignments: null,
      assignments: [],
      note: "The query language is off for this organization: use list_work_items with assigneeId per project.",
    };
  }
  const query: CqlQuery = {
    v: CQL_VERSION,
    where: {
      op: "and",
      args: [
        { op: "cmp", field: { kind: "sys", id: "assignee" }, cmp: "eq", value: { t: "ref", entity: "user", id: userId } },
        {
          op: "in",
          field: { kind: "sys", id: "statusCategory" },
          negate: true,
          values: [{ t: "str", v: "DONE" }, { t: "str", v: "CANCELLED" }],
        },
      ],
    },
  };
  const result = await executeCql(auth, { query }, { pageSize: assignmentLimit ?? 25 });
  return {
    ...base,
    openAssignments: {
      count: result.data.length,
      // null when counting ran out of time.
      total: result.total,
    },
    // Top level, not inside openAssignments: the egress projection keeps a
    // top-level array element by element, but drops an array nested in an
    // object whole, which left a withheld org's model with only the count.
    assignments: result.data.map((r) => ({
      id: r.id,
      ticketNumber: r.ticketNumber,
      ticketKey: r.ticketKey,
      projectId: r.project.id,
      title: r.title,
      columnKey: r.columnKey,
      priority: r.priority,
      dueDate: r.dueDate,
      intervalId: r.intervalId,
    })),
  };
}

// ── add_project_member / remove_project_member ──────────────────────────────

const setMemberSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.nativeEnum(ProjectRole).optional(),
});

export async function addProjectMember(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = setMemberSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, userId } = parsed.data;
  // A project the caller cannot open reads as absent. The authority is the
  // membership service's, the route's own: org owner/admin or project MANAGER.
  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    // Authority before the target is looked up, as the route orders it.
    await requireRosterManage(auth, projectId);
    const target = await orgMemberOf(ctx.orgId, userId);
    if (!target) return { error: "That person isn't a member of this organization." };
    const pm = await setProjectMember(auth, projectId, { orgMemberId: target.id, role: parsed.data.role ?? ProjectRole.MEMBER });
    return { added: true, member: { id: pm.id, projectId, userId, role: pm.role }, name: target.user.displayName };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}

const removeMemberSchema = z.object({ projectId: z.string().uuid(), userId: z.string().uuid() });

export async function removeProjectMemberTool(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = removeMemberSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, userId } = parsed.data;
  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    await requireRosterManage(auth, projectId);
    const target = await orgMemberOf(ctx.orgId, userId);
    if (!target) return { error: "That person isn't a member of this organization." };
    const { count } = await removeProjectMember(auth, projectId, { orgMemberId: target.id });
    if (count === 0) return { removed: false, note: "They were not on this project.", member: { projectId, userId } };
    return { removed: true, member: { projectId, userId }, name: target.user.displayName };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal;
    throw e;
  }
}

// ── add_team_member / remove_team_member ────────────────────────────────────

const teamMemberSchema = z.object({
  projectId: z.string().uuid(),
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  isLead: z.boolean().optional(),
});

/** The person's ProjectMember id on this project, or null. */
async function projectMemberIdOf(orgId: string, projectId: string, userId: string): Promise<string | null> {
  const pm = await prisma.projectMember.findFirst({
    where: { projectId, orgMember: { orgId, userId } },
    select: { id: true },
  });
  return pm?.id ?? null;
}

export async function addTeamMemberTool(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = teamMemberSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, teamId, userId, isLead } = parsed.data;
  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    await requireRosterManage(auth, projectId, "Forbidden");
    const projectMemberId = await projectMemberIdOf(ctx.orgId, projectId, userId);
    if (!projectMemberId) {
      return { error: "That person is not a member of this project. Add them with add_project_member first." };
    }
    const tm = await addTeamMember(auth, projectId, teamId, { projectMemberId, ...(isLead !== undefined ? { isLead } : {}) });
    return { added: !tm.alreadyMember, alreadyMember: tm.alreadyMember, membership: { id: tm.id, teamId, projectId, userId } };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal.error === "Forbidden" ? { error: "You must be a project manager or an org admin to change its teams." } : refusal;
    throw e;
  }
}

const removeTeamMemberSchema = teamMemberSchema.omit({ isLead: true });

export async function removeTeamMemberTool(input: Record<string, unknown>, ctx: ToolContext) {
  const parsed = removeTeamMemberSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, teamId, userId } = parsed.data;
  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Project not found" };

  try {
    await requireRosterManage(auth, projectId, "Forbidden");
    const projectMemberId = await projectMemberIdOf(ctx.orgId, projectId, userId);
    if (!projectMemberId) return { removed: false, note: "They are not on this project, so not on its teams." };
    const { count } = await removeTeamMember(auth, projectId, teamId, projectMemberId);
    return count === 0
      ? { removed: false, note: "They were not on this team.", membership: { teamId, projectId, userId } }
      : { removed: true, membership: { teamId, projectId, userId } };
  } catch (e) {
    const refusal = serviceRefusal(e);
    if (refusal) return refusal.error === "Forbidden" ? { error: "You must be a project manager or an org admin to change its teams." } : refusal;
    throw e;
  }
}
