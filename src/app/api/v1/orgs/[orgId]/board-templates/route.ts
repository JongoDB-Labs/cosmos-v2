import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { uniqueSlug } from "@/lib/templates/slugify";
import { z } from "zod";
import { Prisma } from "@prisma/client";

const createBoardTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.string().min(1).max(100),
  boardType: z.string().min(1).max(50),
  sector: z.string().min(1).max(50).optional(),
  projectTemplateId: z.string().uuid().nullish(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
  description: z.string().nullish(),
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
    const projectTemplateId = request.nextUrl.searchParams.get("projectTemplateId");

    const where: Prisma.BoardTemplateWhereInput = {
      OR: [{ orgId: null }, { orgId }],
    };
    if (sector) {
      where.sector = sector;
    }
    if (projectTemplateId) {
      where.projectTemplateId = projectTemplateId;
    }

    const templates = await prisma.boardTemplate.findMany({
      where,
      include: {
        widgets: true,
      },
      orderBy: [{ isBuiltIn: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
    });

    return success(templates);
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
    const data = createBoardTemplateSchema.parse(body);

    const slug = await uniqueSlug("boardTemplate", data.name, orgId);

    const template = await prisma.boardTemplate.create({
      data: {
        orgId,
        slug,
        name: data.name,
        category: data.category,
        boardType: data.boardType,
        sector: data.sector ?? null,
        projectTemplateId: data.projectTemplateId ?? null,
        defaultConfig: (data.defaultConfig ?? {}) as Prisma.InputJsonValue,
        description: data.description ?? "",
        isBuiltIn: false,
      },
      include: {
        widgets: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board_template.created",
      entity: "board_template",
      entityId: template.id,
      metadata: { name: data.name, category: data.category, boardType: data.boardType } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(template);
  } catch (error) {
    return handleApiError(error);
  }
}
