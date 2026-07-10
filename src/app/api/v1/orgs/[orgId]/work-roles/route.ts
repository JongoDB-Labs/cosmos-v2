import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import {
  Permission,
  permissionMaskFromKeys,
  isPermissionSubset,
} from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { toWorkRoleDto, workRoleCreateSchema } from "@/lib/rbac/work-role";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const roles = await prisma.workRole.findMany({
      where: { orgId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { members: true } } },
    });

    return success(roles.map(toWorkRoleDto));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const data = workRoleCreateSchema.parse(await request.json());
    const mask = permissionMaskFromKeys(data.grants);

    // Escalation guard: you can't mint a role granting permissions you don't
    // hold yourself. The ceiling is ctx.basePermissions (org-role base + member
    // override) — NOT ctx.permissions, which folds in your own work-role grants
    // and would let a self-assigned grant be laundered into new roles. OWNER's
    // base holds all bits, so OWNER can grant anything.
    if (!isPermissionSubset(mask, ctx.basePermissions)) {
      return new Response(
        JSON.stringify({
          error: "A work role can't grant permissions you don't have",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const role = await prisma.workRole.create({
        data: {
          orgId,
          key: data.key,
          name: data.name,
          description: data.description ?? null,
          grants: mask.toString(),
          policies: (data.policies ?? []) as Prisma.InputJsonValue,
        },
        include: { _count: { select: { members: true } } },
      });
      await logAudit({
        orgId,
        userId: ctx.userId,
        action: "work_role.created",
        entity: "work_role",
        entityId: role.id,
        metadata: { key: role.key, grants: String(data.grants.length) } as Record<string, string>,
        ipAddress: getIpAddress(request),
      });
      return created(toWorkRoleDto(role));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return new Response(
          JSON.stringify({ error: "A work role with that key already exists" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      throw e;
    }
  } catch (e) {
    return handleApiError(e);
  }
}
