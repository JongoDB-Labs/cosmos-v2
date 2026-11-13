import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, type AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { evaluateAccess } from "@/lib/abac/engine";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

/**
 * The one answer to "may this caller read this meeting", for every door: the
 * list, a meeting by id and everything under it (attendees, invitation, Teams,
 * edits), and Cosmo's meeting tools. A meeting is readable when its project is
 * visible to the caller (a key's project scope, a team-scoped project's team)
 * AND MEETING_READ passes for that project: the permission bit and any policy
 * (ABAC) on MEETING_READ. A meeting under no project needs MEETING_READ alone,
 * policies included, with nothing to say about a project.
 *
 * Under a project, that is the shared project-read rule asked about
 * MEETING_READ (getReadableProjectIds), the same rule the work-item list asks
 * about ITEM_READ.
 *
 * Two doors used to answer differently: the list asked about ITEM_READ, by id
 * asked about visibility alone, and neither honoured a policy on MEETING_READ.
 */
export interface MeetingReadScope {
  /** Meetings under no project. */
  orgLevel: boolean;
  /** The projects whose meetings may be read. */
  projectIds: string[];
}

/**
 * MEETING_READ for meetings under no project: the permission bit and any
 * policy on MEETING_READ (a policy about a project says nothing here). A
 * person who owns the org is never locked out by a policy; a key they minted is.
 */
function orgLevelMeetingRead(ctx: AuthContext): boolean {
  return evaluateAccess({
    effectivePermissions: ctx.permissions,
    action: "MEETING_READ",
    isOwner: ctx.orgRole === "OWNER",
    isApiKey: ctx.isApiKey,
    actorUserId: ctx.userId,
    resource: { orgId: ctx.orgId, projectId: null },
    rules: ctx.abacRules,
  });
}

/**
 * Which meetings this caller may read. Under a project: the projects the
 * shared project-read rule gives for MEETING_READ (a key's project scope, a
 * team-scoped project's team, the bit, and policies on MEETING_READ).
 */
export async function meetingReadScope(ctx: AuthContext): Promise<MeetingReadScope> {
  return { orgLevel: orgLevelMeetingRead(ctx), projectIds: await getReadableProjectIds(ctx, "MEETING_READ") };
}

/** May this caller read a meeting under `projectId` (null: under no project)? */
export async function canReadMeeting(ctx: AuthContext, projectId: string | null): Promise<boolean> {
  if (!projectId) return orgLevelMeetingRead(ctx);
  return (await getReadableProjectIds(ctx, "MEETING_READ")).includes(projectId);
}

/** The meetings this caller may read, as a filter for a list. */
export async function readableMeetingsWhere(ctx: AuthContext): Promise<Prisma.SyncMeetingWhereInput> {
  const scope = await meetingReadScope(ctx);
  return {
    orgId: ctx.orgId,
    OR: [...(scope.orgLevel ? [{ projectId: null }] : []), { projectId: { in: scope.projectIds } }],
  };
}

/**
 * The signed-in caller and a meeting they may read (canReadMeeting). Null when
 * there is no such meeting, or it is hidden from them: answer both with the
 * same 404, so a hidden meeting can't be told from a missing one. Throws on a
 * missing MEETING_READ bit, as requirePermission does.
 */
export async function meetingReader(
  orgId: string,
  meetingId: string,
): Promise<{ org: { id: string; slug: string }; ctx: AuthContext; meeting: { id: string; projectId: string | null } } | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) return null;
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return null;
  requirePermission(ctx, Permission.MEETING_READ);
  const meeting = await prisma.syncMeeting.findFirst({ where: { id: meetingId, orgId }, select: { id: true, projectId: true } });
  if (!meeting || !(await canReadMeeting(ctx, meeting.projectId))) return null;
  return { org, ctx, meeting };
}
