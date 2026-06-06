import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  crmStageSchema,
  canonicalizeStageFilter,
  DEFAULT_CRM_STAGE,
} from "@/lib/crm/stages";

const createContactSchema = z.object({
  name: z.string().min(1).max(200),
  stage: crmStageSchema,
  value: z.string().nullish(),
  dealValue: z.number().optional(),
  contactInfo: z.string().nullish(),
  ownerId: z.string().uuid().nullish(),
  notes: z.string().nullish(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const stage = request.nextUrl.searchParams.get("stage");
    const search = request.nextUrl.searchParams.get("search");

    const contacts = await prisma.crmContact.findMany({
      where: {
        orgId,
        ...(stage ? { stage: canonicalizeStageFilter(stage) } : {}),
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return success(contacts);
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
    requirePermission(ctx, Permission.CRM_CREATE);

    const body = await request.json();
    const data = createContactSchema.parse(body);

    const contact = await prisma.crmContact.create({
      data: {
        orgId,
        name: data.name,
        stage: data.stage ?? DEFAULT_CRM_STAGE,
        value: data.value ?? null,
        dealValue: data.dealValue ?? null,
        contactInfo: data.contactInfo ?? null,
        ownerId: data.ownerId ?? null,
        notes: data.notes ?? null,
        customFields: (data.customFields ?? {}) as Prisma.InputJsonValue,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "crm_contact.created",
      entity: "crm_contact",
      entityId: contact.id,
      metadata: { name: data.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(contact);
  } catch (error) {
    return handleApiError(error);
  }
}
