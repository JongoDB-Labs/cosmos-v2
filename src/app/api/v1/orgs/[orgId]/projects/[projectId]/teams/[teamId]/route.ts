import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { addTeamMember, removeTeamMember, requireTeamManage } from "@/lib/projects/membership.server";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; teamId: string }>;
};

/**
 * Team membership, and deleting a team.
 *
 * Both require canManageProject rather than plain project-edit rights. Once
 * teamScopedAccess is on, adding someone to a team can grant them sight of a
 * restricted project and removing them can take it away — these are
 * access-control actions wearing the clothes of a roster edit.
 */

// The gate and the membership writes live in the membership service, which the
// assistant's people tools call too: one rule, two entry points.

async function authenticate(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { ok: false as const, error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { ok: false as const, error: new Response("Unauthorized", { status: 401 }) };
  return { ok: true as const, ctx };
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  try {
    const { orgId, projectId, teamId } = await params;
    const r = await authenticate(orgId);
    if (!r.ok) return r.error;

    const body = await request.json().catch(() => null);
    const tm = await addTeamMember(r.ctx, projectId, teamId, body, { ipAddress: getIpAddress(request) });
    // Idempotent: re-adding someone already on the team is a no-op, not an
    // error. The UI can retry a dropped request without special-casing it.
    if (tm.alreadyMember) return success({ id: tm.id, alreadyMember: true });
    return created({ id: tm.id, isLead: tm.isLead });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * With `?projectMemberId=…` removes that person from the team; without it,
 * deletes the team. One route because both are "unmake part of this team", and
 * both carry the same authority.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  try {
    const { orgId, projectId, teamId } = await params;
    const r = await authenticate(orgId);
    if (!r.ok) return r.error;

    const projectMemberId = request.nextUrl.searchParams.get("projectMemberId");

    if (projectMemberId) {
      await removeTeamMember(r.ctx, projectId, teamId, projectMemberId, { ipAddress: getIpAddress(request) });
      return success({ removed: true });
    }

    const team = await requireTeamManage(r.ctx, projectId, teamId);
    // Team rows cascade to team_members, so this does not strand membership.
    await prisma.team.delete({ where: { id: teamId } });
    await logAudit({
      orgId,
      userId: r.ctx.userId,
      action: "project_team.delete",
      entity: "project",
      entityId: projectId,
      metadata: { teamId, name: team.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });
    return success({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
