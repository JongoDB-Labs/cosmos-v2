import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { canManageProject } from "@/lib/rbac/scope";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { revalidateOrgProjects } from "@/lib/cache/queries";
import { z } from "zod";
import { Prisma } from "@prisma/client";

// Project features that drive the optional board tabs (see board-tabs.tsx).
// Toggleable from Project Settings; validated here so only known flags persist.
export const TOGGLEABLE_FEATURES = [
  "okr",
  "goal",
  "kpi",
  "milestone",
  "cycle",
  "roadmap",
] as const;

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullish(),
  settings: z.record(z.string(), z.unknown()).optional(),
  archived: z.boolean().optional(),
  // Accept any string array but FILTER to the known toggleable set rather than
  // hard-rejecting. A project seeded/imported with a legacy flag (e.g. a RAID
  // board's "risk") would otherwise 400 the entire update the moment the client
  // round-trips the stored array while toggling another feature on/off. Filtering
  // both fixes that and cleans the orphaned value out on the next save.
  enabledFeatures: z
    .array(z.string())
    .transform((arr) =>
      arr.filter((f) => (TOGGLEABLE_FEATURES as readonly string[]).includes(f)),
    )
    .optional(),
});

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      include: {
        boards: {
          include: { columns: { orderBy: { sortOrder: "asc" } } },
          orderBy: { sortOrder: "asc" },
        },
        cycles: { orderBy: { number: "desc" } },
        members: {
          include: {
            orgMember: {
              select: {
                id: true,
                role: true,
                user: {
                  select: { id: true, email: true, displayName: true, avatarUrl: true },
                },
              },
            },
          },
        },
        _count: { select: { boards: true, cycles: true, members: true } },
      },
    });

    if (!project) return new Response("Not found", { status: 404 });

    return success(project);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Inheriting authority: an org-wide PROJECT_UPDATE holder OR a MANAGER of
    // THIS project may edit it — so a project-admin can run their own project
    // without org-wide grants.
    if (
      !hasPermission(ctx.permissions, Permission.PROJECT_UPDATE) &&
      !(await canManageProject(ctx, projectId))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const existing = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateProjectSchema.parse(body);

    const updated = await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        // MERGE settings (don't clobber): a partial patch like
        // `{ settings: { defaultBoardId } }` keeps every other setting intact.
        ...(data.settings !== undefined && {
          settings: {
            ...((existing.settings as Record<string, unknown> | null) ?? {}),
            ...data.settings,
          } as Prisma.InputJsonValue,
        }),
        ...(data.archived !== undefined && { archived: data.archived }),
        ...(data.enabledFeatures !== undefined && { enabledFeatures: data.enabledFeatures }),
      },
      include: {
        _count: { select: { boards: true, cycles: true, members: true } },
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "project.updated",
      entity: "project",
      entityId: projectId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Name change or archive toggle both affect the cached project list.
    revalidateOrgProjects(orgId);

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_DELETE);

    const existing = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.project.delete({ where: { id: projectId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "project.deleted",
      entity: "project",
      entityId: projectId,
      metadata: { name: existing.name, key: existing.key } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    revalidateOrgProjects(orgId);

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
