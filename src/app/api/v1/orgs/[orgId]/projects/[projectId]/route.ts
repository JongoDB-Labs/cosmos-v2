import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
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
] as const;

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullish(),
  settings: z.record(z.string(), z.unknown()).optional(),
  archived: z.boolean().optional(),
  enabledFeatures: z.array(z.enum(TOGGLEABLE_FEATURES)).optional(),
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
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateProjectSchema.parse(body);

    const updated = await prisma.project.update({
      where: { id: projectId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description ?? "" }),
        ...(data.settings !== undefined && { settings: data.settings as Prisma.InputJsonValue }),
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
