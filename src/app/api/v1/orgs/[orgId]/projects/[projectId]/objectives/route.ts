import { NextRequest } from "next/server";
import { z } from "zod";
import { ObjectiveStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_READ);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const objectives = await prisma.objective.findMany({
      where: { orgId, projectId },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
      orderBy: { createdAt: "asc" },
    });

    return success(objectives);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  period: z.string().nullish(),
  status: z.nativeEnum(ObjectiveStatus).default(ObjectiveStatus.ACTIVE),
  parentId: z.string().uuid().nullish(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_CREATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

    const created = await prisma.objective.create({
      data: {
        orgId,
        projectId,
        title: data.title,
        description: data.description ?? null,
        period: data.period ?? null,
        status: data.status,
        parentId: data.parentId ?? null,
        progress: 0,
      },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
    });

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
