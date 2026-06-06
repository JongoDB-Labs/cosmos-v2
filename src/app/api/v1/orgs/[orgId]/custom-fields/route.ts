import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { FieldType } from "@prisma/client";
import type { Prisma } from "@prisma/client";

const createFieldSchema = z.object({
  name: z.string().min(1).max(100),
  key: z.string().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/, "Key must be lowercase alphanumeric with underscores"),
  fieldType: z.nativeEnum(FieldType),
  options: z.array(z.unknown()).optional(),
  required: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const projectId = request.nextUrl.searchParams.get("projectId");

    const where: Prisma.CustomFieldWhereInput = {
      orgId,
      ...(projectId ? { projectId } : {}),
    };

    const fields = await prisma.customField.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    return success(fields);
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
    requirePermission(ctx, Permission.CUSTOM_FIELD_MANAGE);

    const body = await request.json();
    const data = createFieldSchema.parse(body);

    const projectId = data.projectId ?? null;

    const existing = await prisma.customField.findFirst({
      where: { orgId, key: data.key },
    });
    if (existing) {
      return new Response(
        JSON.stringify({ error: `Custom field with key '${data.key}' already exists` }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const field = await prisma.customField.create({
      data: {
        orgId,
        projectId,
        name: data.name,
        key: data.key,
        fieldType: data.fieldType,
        options: (data.options ?? []) as Prisma.InputJsonValue,
        required: data.required ?? false,
        sortOrder: data.sortOrder ?? 0,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "custom_field.created",
      entity: "custom_field",
      entityId: field.id,
      metadata: { name: data.name, key: data.key, fieldType: data.fieldType } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(field);
  } catch (error) {
    return handleApiError(error);
  }
}
