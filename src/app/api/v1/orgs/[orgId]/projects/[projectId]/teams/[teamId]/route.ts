import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canManageProject } from "@/lib/rbac/scope";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

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

const addSchema = z.object({
  projectMemberId: z.string().uuid(),
  isLead: z.boolean().optional(),
});

function forbidden() {
  return new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

async function resolve(orgId: string, projectId: string, teamId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { ok: false as const, error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { ok: false as const, error: new Response("Unauthorized", { status: 401 }) };
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true },
  });
  if (!project) return { ok: false as const, error: new Response("Not found", { status: 404 }) };
  if (!(await canManageProject(ctx, projectId))) return { ok: false as const, error: forbidden() };
  // Scoped by projectId so a team id from another project cannot be driven
  // through this route.
  const team = await prisma.team.findFirst({
    where: { id: teamId, projectId },
    select: { id: true, name: true },
  });
  if (!team) return { ok: false as const, error: new Response("Not found", { status: 404 }) };
  return { ok: true as const, ctx, team };
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  try {
    const { orgId, projectId, teamId } = await params;
    const r = await resolve(orgId, projectId, teamId);
    if (!r.ok) return r.error;

    const parsed = addSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: "A project member is required." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const { projectMemberId, isLead } = parsed.data;

    // The invariant the FK enforces, checked here so it reads as a 400 rather
    // than surfacing a raw constraint violation as a 500: you cannot be on a
    // project's team without being on the project.
    const pm = await prisma.projectMember.findFirst({
      where: { id: projectMemberId, projectId },
      select: { id: true },
    });
    if (!pm) {
      return new Response(
        JSON.stringify({ error: "That person is not a member of this project." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Idempotent: re-adding someone already on the team is a no-op, not an
    // error. The UI can retry a dropped request without special-casing it.
    const existing = await prisma.teamMember.findFirst({
      where: { teamId, projectMemberId },
      select: { id: true },
    });
    if (existing) return success({ id: existing.id, alreadyMember: true });

    const tm = await prisma.teamMember.create({
      data: { teamId, projectMemberId, isLead: isLead ?? false },
      select: { id: true, isLead: true },
    });

    await logAudit({
      orgId,
      userId: r.ctx.userId,
      action: "project_team.member_add",
      entity: "project",
      entityId: projectId,
      metadata: { teamId, projectMemberId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(tm);
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
    const r = await resolve(orgId, projectId, teamId);
    if (!r.ok) return r.error;

    const projectMemberId = request.nextUrl.searchParams.get("projectMemberId");

    if (projectMemberId) {
      await prisma.teamMember.deleteMany({ where: { teamId, projectMemberId } });
      await logAudit({
        orgId,
        userId: r.ctx.userId,
        action: "project_team.member_remove",
        entity: "project",
        entityId: projectId,
        metadata: { teamId, projectMemberId } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });
      return success({ removed: true });
    }

    // Team rows cascade to team_members, so this does not strand membership.
    await prisma.team.delete({ where: { id: teamId } });
    await logAudit({
      orgId,
      userId: r.ctx.userId,
      action: "project_team.delete",
      entity: "project",
      entityId: projectId,
      metadata: { teamId, name: r.team.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });
    return success({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}
