import { NextRequest } from "next/server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { listWorkItemTypes } from "./route.contract";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createWorkItemTypeSchema = z.object({
  key: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/, "Key must be lowercase alphanumeric with hyphens/underscores"),
  name: z.string().min(1).max(100),
  pluralName: z.string().max(100).nullish(),
  icon: z.string().max(100).nullish(),
  color: z.string().max(20).nullish(),
  defaultParentTypeKey: z.string().max(50).nullish(),
  celebrateOnComplete: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listWorkItemTypes);
    const { params: { orgId } } = await parseRequest(listWorkItemTypes, request, params);
    requirePermission(ctx, Permission.PROJECT_READ);

    const types = await prisma.workItemType.findMany({
      where: {
        OR: [{ orgId: null }, { orgId }],
      },
      orderBy: [{ isBuiltIn: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    });

    return respond(listWorkItemTypes, 200, types);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return problem(404, "not_found", undefined, { request });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return problem(401, "unauthorized", undefined, { request });
    requirePermission(ctx, Permission.ORG_MANAGE_TEMPLATES);

    const body = await request.json();
    const data = createWorkItemTypeSchema.parse(body);

    // Check for key uniqueness within the org
    const existing = await prisma.workItemType.findFirst({
      where: { orgId, key: data.key },
    });
    if (existing) {
      return problem(409, "conflict", "Work item type key already exists in this org", { request });
    }

    const maxSort = await prisma.workItemType.aggregate({
      where: { orgId },
      _max: { sortOrder: true },
    });

    const workItemType = await prisma.workItemType.create({
      data: {
        orgId,
        key: data.key,
        name: data.name,
        pluralName: data.pluralName ?? null,
        icon: data.icon ?? null,
        color: data.color ?? null,
        defaultParentTypeKey: data.defaultParentTypeKey ?? null,
        celebrateOnComplete: data.celebrateOnComplete ?? false,
        isBuiltIn: false,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item_type.created",
      entity: "work_item_type",
      entityId: workItemType.id,
      metadata: { key: data.key, name: data.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(workItemType);
  } catch (error) {
    return handleApiError(error, request);
  }
}
