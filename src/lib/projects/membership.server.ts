/**
 * Who is on a project, and on which of its teams — the writes, with their gates.
 *
 * The project-members and team routes and the assistant's people tools both
 * call these, so "who may change a roster" is decided once. It is
 * `canManageProject` with PROJECT_MANAGE: an org owner or admin, or a MANAGER of
 * this project. Deliberately NOT `requireProjectManage`, whose org-wide-bit
 * branch would admit anyone holding the delegable PROJECT_MANAGE bit on every
 * project. With `teamScopedAccess` on, adding someone to a project or a team
 * grants them sight of it, so these are access-control writes.
 *
 * Refusals throw the route error classes, so `handleApiError` answers with the
 * status the routes always gave.
 */
import { z } from "zod";
import { ProjectRole } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { ConflictError, ForbiddenError, NotFoundError, type AuthContext } from "@/lib/rbac/check";
import { ProblemError } from "@/lib/openapi/problem";
import { Permission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";

export interface MembershipWriteMeta {
  ipAddress?: string | null;
}

const MANAGE_REFUSAL = "You must be a project manager or an org admin to manage project access.";

/** The project must belong to the caller's org (tenant isolation); 404 otherwise. */
async function requireProjectInOrg(ctx: AuthContext, projectId: string): Promise<void> {
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId: ctx.orgId }, select: { id: true } });
  if (!project) throw new NotFoundError("Not found");
}

export const LAST_MANAGER_REFUSAL = "This is the project's only manager. Make someone else a manager first.";

/**
 * Refuse a change that would leave the project without a manager: removing, or
 * giving another role to, the one MANAGER it has. A manager whose org
 * membership was removed is not counted, since they can no longer act.
 */
async function requireAnotherManager(projectId: string, orgMemberId: string): Promise<void> {
  const target = await prisma.projectMember.findUnique({
    where: { projectId_orgMemberId: { projectId, orgMemberId } },
    select: { role: true },
  });
  if (target?.role !== ProjectRole.MANAGER) return;
  const others = await prisma.projectMember.count({
    where: { projectId, role: ProjectRole.MANAGER, orgMemberId: { not: orgMemberId }, orgMember: { removedAt: null } },
  });
  if (others === 0) throw new ConflictError(LAST_MANAGER_REFUSAL);
}

/** May this actor change who is on this project? */
export async function requireRosterManage(ctx: AuthContext, projectId: string, message = MANAGE_REFUSAL): Promise<void> {
  if (!(await canManageProject(ctx, projectId, Permission.PROJECT_MANAGE))) throw new ForbiddenError(message);
}

export const setProjectMemberSchema = z.object({
  orgMemberId: z.string().uuid(),
  role: z.nativeEnum(ProjectRole),
});

/** Add someone to a project, or change their project role: `PUT .../members`. */
export async function setProjectMember(ctx: AuthContext, projectId: string, input: unknown, meta: MembershipWriteMeta = {}) {
  await requireProjectInOrg(ctx, projectId);
  await requireRosterManage(ctx, projectId);

  const { orgMemberId, role } = setProjectMemberSchema.parse(input);
  // No cross-tenant assignment: the target must be a member of THIS org.
  const target = await prisma.orgMember.findFirst({ where: { id: orgMemberId, orgId: ctx.orgId }, select: { id: true } });
  if (!target) throw new ProblemError(400, "invalid_request", "That person isn't a member of this organization.");
  if (role !== ProjectRole.MANAGER) await requireAnotherManager(projectId, orgMemberId);

  const pm = await prisma.projectMember.upsert({
    where: { projectId_orgMemberId: { projectId, orgMemberId } },
    update: { role },
    create: { projectId, orgMemberId, role },
  });
  await logAudit({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "project_member.set",
    entity: "project",
    entityId: projectId,
    metadata: { orgMemberId, role } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return { id: pm.id, orgMemberId, role };
}

export const removeProjectMemberSchema = z.object({ orgMemberId: z.string().uuid() });

/** Take someone off a project: `DELETE .../members`. Removing someone not on it is a no-op. */
export async function removeProjectMember(ctx: AuthContext, projectId: string, input: unknown, meta: MembershipWriteMeta = {}) {
  await requireProjectInOrg(ctx, projectId);
  await requireRosterManage(ctx, projectId);

  const { orgMemberId } = removeProjectMemberSchema.parse(input);
  await requireAnotherManager(projectId, orgMemberId);
  const { count } = await prisma.projectMember.deleteMany({ where: { projectId, orgMemberId } });
  await logAudit({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "project_member.remove",
    entity: "project",
    entityId: projectId,
    metadata: { orgMemberId } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return { removed: true, count };
}

/**
 * The gate every team write shares: the project is in the org, the actor may
 * manage its roster, and the team belongs to THIS project (so a team id from
 * another project cannot be driven through it). Returns the team.
 */
export async function requireTeamManage(ctx: AuthContext, projectId: string, teamId: string) {
  await requireProjectInOrg(ctx, projectId);
  await requireRosterManage(ctx, projectId, "Forbidden");
  const team = await prisma.team.findFirst({ where: { id: teamId, projectId }, select: { id: true, name: true } });
  if (!team) throw new NotFoundError("Not found");
  return team;
}

export const addTeamMemberSchema = z.object({
  projectMemberId: z.string().uuid(),
  isLead: z.boolean().optional(),
});

/**
 * Put a project member on one of its teams: `POST .../teams/:teamId`.
 * Idempotent: someone already on the team is reported, not an error.
 */
export async function addTeamMember(
  ctx: AuthContext,
  projectId: string,
  teamId: string,
  input: unknown,
  meta: MembershipWriteMeta = {},
): Promise<{ id: string; isLead?: boolean; alreadyMember: boolean }> {
  await requireTeamManage(ctx, projectId, teamId);

  const parsed = addTeamMemberSchema.safeParse(input);
  if (!parsed.success) throw new ProblemError(400, "invalid_request", "A project member is required.");
  const { projectMemberId, isLead } = parsed.data;

  // The invariant the FK enforces, checked here so it reads as a 400 rather
  // than surfacing a raw constraint violation as a 500: you cannot be on a
  // project's team without being on the project.
  const pm = await prisma.projectMember.findFirst({ where: { id: projectMemberId, projectId }, select: { id: true } });
  if (!pm) throw new ProblemError(400, "invalid_request", "That person is not a member of this project.");

  const existing = await prisma.teamMember.findFirst({ where: { teamId, projectMemberId }, select: { id: true } });
  if (existing) return { id: existing.id, alreadyMember: true };

  const tm = await prisma.teamMember.create({
    data: { teamId, projectMemberId, isLead: isLead ?? false },
    select: { id: true, isLead: true },
  });
  await logAudit({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "project_team.member_add",
    entity: "project",
    entityId: projectId,
    metadata: { teamId, projectMemberId } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return { id: tm.id, isLead: tm.isLead, alreadyMember: false };
}

/** Take a project member off a team: `DELETE .../teams/:teamId?projectMemberId=`. */
export async function removeTeamMember(
  ctx: AuthContext,
  projectId: string,
  teamId: string,
  projectMemberId: string,
  meta: MembershipWriteMeta = {},
) {
  await requireTeamManage(ctx, projectId, teamId);
  const { count } = await prisma.teamMember.deleteMany({ where: { teamId, projectMemberId } });
  await logAudit({
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "project_team.member_remove",
    entity: "project",
    entityId: projectId,
    metadata: { teamId, projectMemberId } as Record<string, string>,
    ipAddress: meta.ipAddress ?? undefined,
  });
  return { removed: true, count };
}
