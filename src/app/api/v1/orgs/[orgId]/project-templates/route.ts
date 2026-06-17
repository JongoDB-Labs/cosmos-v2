import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { uniqueSlug } from "@/lib/templates/slugify";
import { getEntitlements, filterBySector } from "@/lib/entitlements";
import { z } from "zod";
import { Prisma } from "@prisma/client";

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  sector: z.string().min(1).max(50),
  description: z.string().nullish(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const sector = request.nextUrl.searchParams.get("sector");

    const where: Record<string, unknown> = {
      OR: [{ orgId: null }, { orgId }],
    };
    if (sector) {
      where.sector = sector;
    }

    const templates = await prisma.projectTemplate.findMany({
      where,
      include: {
        boardTemplates: {
          select: { id: true, name: true, boardType: true, sortOrder: true },
        },
        _count: { select: { workItemTypes: true } },
      },
      orderBy: [{ isBuiltIn: "desc" }, { createdAt: "desc" }],
    });

    const ent = await getEntitlements(orgId);
    return success(filterBySector(templates, ent));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_TEMPLATES);

    const body = await request.json();
    const data = createTemplateSchema.parse(body);

    const slug = await uniqueSlug("projectTemplate", data.name, orgId);

    const template = await prisma.projectTemplate.create({
      data: {
        orgId,
        slug,
        name: data.name,
        sector: data.sector,
        description: data.description ?? "",
        defaultConfig: (data.defaultConfig ?? {}) as Prisma.InputJsonValue,
        isBuiltIn: false,
      },
      include: {
        boardTemplates: {
          select: { id: true, name: true, boardType: true, sortOrder: true },
        },
        _count: { select: { workItemTypes: true } },
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "project_template.created",
      entity: "project_template",
      entityId: template.id,
      metadata: { name: data.name, sector: data.sector } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(template);
  } catch (error) {
    return handleApiError(error);
  }
}
