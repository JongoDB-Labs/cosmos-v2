import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
  category: z.string().min(1).max(50),
  methodology: z.string().max(50).nullish(),
  description: z.string().max(500).nullish(),
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
    requirePermission(ctx, Permission.TEMPLATE_READ);

    const category = request.nextUrl.searchParams.get("category");
    const methodology = request.nextUrl.searchParams.get("methodology");

    const where: Prisma.BoardTemplateWhereInput = {
      OR: [{ orgId: null }, { orgId }],
      ...(category ? { category } : {}),
      ...(methodology ? { methodology } : {}),
    };

    const templates = await prisma.boardTemplate.findMany({
      where,
      orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
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
    requirePermission(ctx, Permission.TEMPLATE_MANAGE);

    const body = await request.json();
    const data = createTemplateSchema.parse(body);

    const existing = await prisma.boardTemplate.findUnique({
      where: { orgId_slug: { orgId, slug: data.slug } },
    });
    if (existing) {
      return new Response(
        JSON.stringify({ error: "Template slug already exists" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const template = await prisma.boardTemplate.create({
      data: {
        orgId,
        slug: data.slug,
        name: data.name,
        category: data.category,
        methodology: data.methodology ?? null,
        description: data.description ?? "",
        isBuiltIn: false,
        isPublished: false,
        defaultConfig: (data.defaultConfig ?? {}) as Prisma.InputJsonValue,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "template.created",
      entity: "board_template",
      entityId: template.id,
      metadata: { name: data.name, slug: data.slug } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(template);
  } catch (error) {
    return handleApiError(error);
  }
}
