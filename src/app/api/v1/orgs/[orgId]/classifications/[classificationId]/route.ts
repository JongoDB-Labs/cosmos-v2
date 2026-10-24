import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { sweepMarkedComments } from "@/lib/feedback/comments.server";
import { z } from "zod";
import { ClassificationLevel } from "@prisma/client";
import { syncInvitesAfterClassification } from "@/lib/integrations/microsoft/calendar-sync.server";

const updateClassificationSchema = z.object({
  level: z.nativeEnum(ClassificationLevel).optional(),
  markings: z.array(z.string()).optional(),
  handlingInstructions: z.string().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string; classificationId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, classificationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CLASSIFICATION_READ);

    const classification = await prisma.dataClassification.findFirst({
      where: { id: classificationId, orgId },
    });

    if (!classification) return new Response("Not found", { status: 404 });

    return success(classification);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, classificationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CLASSIFICATION_MANAGE);

    const existing = await prisma.dataClassification.findFirst({
      where: { id: classificationId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateClassificationSchema.parse(body);

    const updated = await prisma.dataClassification.update({
      where: { id: classificationId },
      data: {
        ...(data.level !== undefined && { level: data.level }),
        ...(data.markings !== undefined && { markings: data.markings }),
        ...(data.handlingInstructions !== undefined && { handlingInstructions: data.handlingInstructions ?? "" }),
        appliedById: ctx.userId,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "data_classification.updated",
      entity: "data_classification",
      entityId: classificationId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Live Outlook invitations of a meeting this now classifies are cancelled at once.
    await syncInvitesAfterClassification(orgId, updated.projectId).catch(
      (e) => console.error("outlook invite re-check failed:", e instanceof Error ? e.message : "unknown error"),
    );
    // Feedback comments marked above what the org now covers go internal.
    await sweepMarkedComments({ orgId, actorId: ctx.userId, reason: "ceiling_changed", ipAddress: getIpAddress(request) }).catch(
      (e) => console.error("feedback marking sweep failed:", e instanceof Error ? e.message : "unknown error"),
    );
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, classificationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CLASSIFICATION_MANAGE);

    const existing = await prisma.dataClassification.findFirst({
      where: { id: classificationId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateClassificationSchema.partial().parse(body);

    const updated = await prisma.dataClassification.update({
      where: { id: classificationId },
      data: {
        ...(data.level !== undefined && { level: data.level }),
        ...(data.markings !== undefined && { markings: data.markings }),
        ...(data.handlingInstructions !== undefined && {
          handlingInstructions: data.handlingInstructions ?? "",
        }),
        appliedById: ctx.userId,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "data_classification.patched",
      entity: "data_classification",
      entityId: classificationId,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Live Outlook invitations of a meeting this now classifies are cancelled at once.
    await syncInvitesAfterClassification(orgId, updated.projectId).catch(
      (e) => console.error("outlook invite re-check failed:", e instanceof Error ? e.message : "unknown error"),
    );
    // Feedback comments marked above what the org now covers go internal.
    await sweepMarkedComments({ orgId, actorId: ctx.userId, reason: "ceiling_changed", ipAddress: getIpAddress(request) }).catch(
      (e) => console.error("feedback marking sweep failed:", e instanceof Error ? e.message : "unknown error"),
    );
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, classificationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CLASSIFICATION_MANAGE);

    const existing = await prisma.dataClassification.findFirst({
      where: { id: classificationId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.dataClassification.delete({ where: { id: classificationId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "data_classification.deleted",
      entity: "data_classification",
      entityId: classificationId,
      metadata: { level: existing.level } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Feedback comments marked above what the org now covers go internal.
    await sweepMarkedComments({ orgId, actorId: ctx.userId, reason: "ceiling_changed", ipAddress: getIpAddress(request) }).catch(
      (e) => console.error("feedback marking sweep failed:", e instanceof Error ? e.message : "unknown error"),
    );
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
