import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { ProjectRole } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

async function resolve(orgId: string, projectId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  // Tenant isolation: the project must belong to this org.
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true },
  });
  if (!project) return { error: new Response("Not found", { status: 404 }) };
  return { ctx };
}

function forbidden() {
  return new Response(
    JSON.stringify({ error: "You must be a project manager or an org admin to manage project access." }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const r = await resolve(orgId, projectId);
    if (r.error) return r.error;
    requirePermission(r.ctx, Permission.PROJECT_READ);

    const members = await prisma.projectMember.findMany({
      where: { projectId },
      select: {
        id: true,
        orgMemberId: true,
        role: true,
        orgMember: {
          select: {
            userId: true,
            user: { select: { displayName: true, email: true, avatarUrl: true } },
          },
        },
      },
    });
    return success(
      members.map((m) => ({
        id: m.id,
        orgMemberId: m.orgMemberId,
        role: m.role,
        userId: m.orgMember.userId,
        displayName: m.orgMember.user.displayName,
        email: m.orgMember.user.email,
        avatarUrl: m.orgMember.user.avatarUrl,
      })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

const putSchema = z.object({
  orgMemberId: z.string().uuid(),
  role: z.nativeEnum(ProjectRole),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const r = await resolve(orgId, projectId);
    if (r.error) return r.error;
    if (!(await canManageProject(r.ctx, projectId))) return forbidden();

    const { orgMemberId, role } = putSchema.parse(await request.json());
    // No cross-tenant assignment: the target must be a member of THIS org.
    const target = await prisma.orgMember.findFirst({
      where: { id: orgMemberId, orgId },
      select: { id: true },
    });
    if (!target) {
      return new Response(
        JSON.stringify({ error: "That person isn't a member of this organization." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const pm = await prisma.projectMember.upsert({
      where: { projectId_orgMemberId: { projectId, orgMemberId } },
      update: { role },
      create: { projectId, orgMemberId, role },
    });
    await logAudit({
      orgId,
      userId: r.ctx.userId,
      action: "project_member.set",
      entity: "project",
      entityId: projectId,
      metadata: { orgMemberId, role } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });
    return success({ id: pm.id, orgMemberId, role });
  } catch (e) {
    return handleApiError(e);
  }
}

const delSchema = z.object({ orgMemberId: z.string().uuid() });

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const r = await resolve(orgId, projectId);
    if (r.error) return r.error;
    if (!(await canManageProject(r.ctx, projectId))) return forbidden();

    const { orgMemberId } = delSchema.parse(await request.json());
    await prisma.projectMember.deleteMany({ where: { projectId, orgMemberId } });
    await logAudit({
      orgId,
      userId: r.ctx.userId,
      action: "project_member.remove",
      entity: "project",
      entityId: projectId,
      metadata: { orgMemberId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });
    return success({ removed: true });
  } catch (e) {
    return handleApiError(e);
  }
}
