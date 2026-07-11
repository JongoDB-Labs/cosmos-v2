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
import { BUILTIN_KEY_PREFIX } from "@/lib/rbac/builtin-work-roles";

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

    const body: unknown = await request.json();

    // Reserved key prefix: checked on the RAW body, not `data.key` post-parse.
    // The key-format regex below (lowercase letters/digits/underscores only)
    // already rejects any dotted key, so a `builtin.*` key never survives
    // workRoleCreateSchema.parse() — gating on the parsed value would make
    // this branch unreachable and surface a generic validation error instead
    // of this specific, UI-facing one.
    const rawKey = (body as { key?: unknown } | null)?.key;
    if (typeof rawKey === "string" && rawKey.startsWith(BUILTIN_KEY_PREFIX)) {
      return new Response(
        JSON.stringify({ error: "role key prefix is reserved" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = workRoleCreateSchema.parse(body);

    // Name uniqueness (case-insensitive) is app-level — the DB only enforces
    // uniqueness on { orgId, key }. Checked before the escalation guard below
    // so a name clash always reports 409, never masked by a 403.
    const nameClash = await prisma.workRole.findFirst({
      where: { orgId, name: { equals: data.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (nameClash) {
      return new Response(
        JSON.stringify({ error: "a role with this name already exists" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

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
          grants: mask,
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
