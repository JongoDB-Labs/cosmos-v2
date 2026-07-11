import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import {
  Permission,
  permissionMaskFromKeys,
  isPermissionSubset,
} from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { toWorkRoleDto, workRoleUpdateSchema } from "@/lib/rbac/work-role";
import { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; roleId: string }> };

async function load(orgId: string, roleId: string) {
  return prisma.workRole.findFirst({
    where: { id: roleId, orgId },
    include: { _count: { select: { members: true } } },
  });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, roleId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const role = await load(orgId, roleId);
    if (!role) return new Response("Not found", { status: 404 });
    return success(toWorkRoleDto(role));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, roleId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const existing = await prisma.workRole.findFirst({ where: { id: roleId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    // Built-in (platform-managed) roles are read-only end to end (matching the
    // convention used for built-in work-item types / themes / templates) —
    // same error contract as DELETE below; the settings UI matches on it.
    if (existing.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "built-in roles are read-only" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = workRoleUpdateSchema.parse(await request.json());

    if (data.name !== undefined) {
      // Same case-insensitive uniqueness POST enforces on create — a rename
      // must not become a bypass. Excludes the role's own row so re-saving
      // your own name (or just its casing) isn't a false clash.
      const nameClash = await prisma.workRole.findFirst({
        where: { orgId, name: { equals: data.name, mode: "insensitive" }, id: { not: roleId } },
        select: { id: true },
      });
      if (nameClash) {
        return new Response(
          JSON.stringify({ error: "a role with this name already exists" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    let grantsUpdate: { grants?: bigint } = {};
    if (data.grants !== undefined) {
      const mask = permissionMaskFromKeys(data.grants);
      // Ceiling is basePermissions (excludes the actor's own work-role grants)
      // so a self-assigned grant can't be laundered into new roles.
      if (!isPermissionSubset(mask, ctx.basePermissions)) {
        return new Response(
          JSON.stringify({
            error: "A work role can't grant permissions you don't have",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      grantsUpdate = { grants: mask };
    }

    await prisma.workRole.update({
      where: { id: roleId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...grantsUpdate,
        // Deny policies only NARROW access, so (unlike grants) they need no
        // escalation ceiling — anyone who can edit the role can restrict it.
        ...(data.policies !== undefined && {
          policies: data.policies as Prisma.InputJsonValue,
        }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_role.updated",
      entity: "work_role",
      entityId: roleId,
      ipAddress: getIpAddress(request),
    });

    const role = await load(orgId, roleId);
    return success(role ? toWorkRoleDto(role) : { id: roleId });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, roleId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const existing = await prisma.workRole.findFirst({ where: { id: roleId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    // Built-in (platform-managed) roles are read-only end to end — same error
    // contract as PUT above; the settings UI matches on it.
    if (existing.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "built-in roles are read-only" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    // Assignments cascade-delete via the FK.
    await prisma.workRole.delete({ where: { id: roleId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_role.deleted",
      entity: "work_role",
      entityId: roleId,
      metadata: { key: existing.key } as Record<string, string>,
      ipAddress: getIpAddress(_request),
    });

    return noContent();
  } catch (e) {
    return handleApiError(e);
  }
}
