import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, isPermissionSubset } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; roleId: string }> };

async function resolve(orgId: string, roleId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);
  const role = await prisma.workRole.findFirst({ where: { id: roleId, orgId } });
  if (!role) return { error: new Response("Not found", { status: 404 }) };
  return { ctx, role };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, roleId } = await params;
    const r = await resolve(orgId, roleId);
    if (r.error) return r.error;

    const assigned = await prisma.orgMemberWorkRole.findMany({
      where: { workRoleId: roleId },
      select: { orgMemberId: true },
    });
    return success({ orgMemberIds: assigned.map((a) => a.orgMemberId) });
  } catch (e) {
    return handleApiError(e);
  }
}

const setSchema = z.object({
  orgMemberIds: z.array(z.string().uuid()).max(1000),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, roleId } = await params;
    const r = await resolve(orgId, roleId);
    if (r.error) return r.error;

    // Escalation guard at ASSIGNMENT time: you can't assign a role that grants
    // permissions you don't hold yourself. The create/edit subset guard lives
    // on the role *definition*, so without this an ORG_MANAGE_MEMBERS holder
    // could assign an OWNER-authored over-privileged role (e.g. one granting
    // ORG_MANAGE_BILLING / ORG_DELETE) to themselves or anyone and escalate.
    // Ceiling is basePermissions (excludes the actor's own work-role grants) so
    // a self-assigned grant can't be re-laundered. OWNER's base holds all bits.
    if (!isPermissionSubset(r.role.grants ?? 0n, r.ctx.basePermissions)) {
      return new Response(
        JSON.stringify({
          error: "You can't assign a role that grants permissions you don't have",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const { orgMemberIds } = setSchema.parse(await request.json());

    // Only accept ids that are genuinely members of THIS org (no cross-tenant
    // assignment, no dangling ids).
    const valid = await prisma.orgMember.findMany({
      where: { id: { in: orgMemberIds }, orgId },
      select: { id: true },
    });
    const validIds = valid.map((m) => m.id);

    await prisma.$transaction([
      prisma.orgMemberWorkRole.deleteMany({ where: { workRoleId: roleId } }),
      prisma.orgMemberWorkRole.createMany({
        data: validIds.map((id) => ({ orgMemberId: id, workRoleId: roleId })),
        skipDuplicates: true,
      }),
    ]);

    await logAudit({
      orgId,
      userId: r.ctx.userId,
      action: "work_role.members_set",
      entity: "work_role",
      entityId: roleId,
      metadata: { memberCount: String(validIds.length) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ orgMemberIds: validIds });
  } catch (e) {
    return handleApiError(e);
  }
}
