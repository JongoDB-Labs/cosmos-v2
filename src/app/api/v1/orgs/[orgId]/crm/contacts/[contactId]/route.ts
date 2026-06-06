import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { crmStageSchema } from "@/lib/crm/stages";

const updateContactSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  stage: crmStageSchema,
  value: z.string().nullish(),
  dealValue: z.number().nullable().optional(),
  contactInfo: z.string().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string; contactId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, contactId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CRM_READ);

    const contact = await prisma.crmContact.findFirst({
      where: { id: contactId, orgId },
    });

    if (!contact) return new Response("Not found", { status: 404 });

    return success(contact);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, contactId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.crmContact.findFirst({
      where: { id: contactId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: checks CRM_UPDATE in the bitfield AND applies any
    // work-role/member deny policy that references it (narrowing by ownership).
    // CrmContact.ownerId is nullable — passed as-is; the engine treats a null
    // owner as unresolvable (owns_resource → false). Identical to
    // requirePermission until a policy exists.
    await requireAccess(ctx, "CRM_UPDATE", { ownerId: existing.ownerId });

    const body = await request.json();
    const data = updateContactSchema.parse(body);

    const updated = await prisma.crmContact.update({
      where: { id: contactId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        // `!= null` so an explicit `null` (allowed by the schema) leaves the
        // stage untouched rather than overwriting it.
        ...(data.stage != null && { stage: data.stage }),
        ...(data.value !== undefined && { value: data.value }),

        ...(data.dealValue !== undefined && { dealValue: data.dealValue }),
        ...(data.contactInfo !== undefined && { contactInfo: data.contactInfo }),
        ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.customFields !== undefined && {
          customFields: data.customFields as Prisma.InputJsonValue,
        }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "crm_contact.updated",
      entity: "crm_contact",
      entityId: contactId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, contactId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const existing = await prisma.crmContact.findFirst({
      where: { id: contactId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz (CRM_DELETE + any narrowing deny policy).
    // CrmContact.ownerId is nullable — passed as-is (null → owns_resource false).
    await requireAccess(ctx, "CRM_DELETE", { ownerId: existing.ownerId });

    await prisma.crmContact.delete({ where: { id: contactId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "crm_contact.deleted",
      entity: "crm_contact",
      entityId: contactId,
      metadata: { name: existing.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
