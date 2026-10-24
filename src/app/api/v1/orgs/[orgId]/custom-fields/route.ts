import { NextRequest } from "next/server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { listCustomFields } from "./route.contract";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { FieldType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

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
    const { ctx } = await orgContext((await params).orgId, listCustomFields);
    const { params: { orgId }, query: { projectId } } = await parseRequest(listCustomFields, request, params);
    // ORG_READ for a session; a key's `read` scope deliberately lacks it (see
    // SCOPE_MASK in lib/auth/api-key.ts), so a key reads this with PROJECT_READ.
    requirePermission(ctx, ctx.isApiKey ? Permission.PROJECT_READ : Permission.ORG_READ);

    // A key sees org-wide fields and those of projects it can read (its
    // projectScope and team scoping); a session sees the org's, as before.
    const readable = ctx.isApiKey ? await getReadableProjectIds(ctx) : null;
    const where: Prisma.CustomFieldWhereInput = {
      orgId,
      ...(projectId ? { projectId } : {}),
      ...(readable ? { OR: [{ projectId: null }, { projectId: { in: readable } }] } : {}),
    };

    const fields = await prisma.customField.findMany({
      where,
      // Include type bindings so the work-item UI can scope a field to the
      // work-item types it's bound to (no bindings ⇒ shows for every type).
      include: { typeBindings: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    return respond(listCustomFields, 200, fields);
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
    requirePermission(ctx, Permission.CUSTOM_FIELD_MANAGE);

    const body = await request.json();
    const data = createFieldSchema.parse(body);

    const projectId = data.projectId ?? null;

    const existing = await prisma.customField.findFirst({
      where: { orgId, key: data.key },
    });
    if (existing) {
      return problem(409, "conflict", `Custom field with key '${data.key}' already exists`, { request });
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
    return handleApiError(error, request);
  }
}
