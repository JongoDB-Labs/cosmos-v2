import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { getInvoice, updateInvoice } from "@/lib/invoicing/service";
import { invoiceInputSchema } from "@/lib/invoicing/validation";
import { inVisibleProject, requireProjectVisibleIf } from "@/lib/rbac/require-project-read";
import type { AuthContext } from "@/lib/rbac/check";
import { logAudit } from "@/lib/audit";
import { requireAccess } from "@/lib/abac/require-access";
import type { PermissionKey } from "@/lib/rbac/permissions";

type RouteParams = { params: Promise<{ orgId: string; invoiceId: string }> };

async function gate(orgId: string, action: PermissionKey): Promise<Response | AuthContext> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  await requireAccess(ctx, action);
  return ctx;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const ctx = await gate(orgId, "FINANCE_READ");
    if (ctx instanceof Response) return ctx;
    const invoice = await getInvoice(orgId, invoiceId);
    // On a project the caller can't see: the same 404 as no such invoice.
    if (!invoice || !(await inVisibleProject(ctx, invoice.projectId))) return new Response("Not found", { status: 404 });
    return success(invoice);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const ctx = await gate(orgId, "FINANCE_MANAGE");
    if (ctx instanceof Response) return ctx;
    const existing = await prisma.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { projectId: true } });
    if (!existing || !(await inVisibleProject(ctx, existing.projectId))) return new Response("Not found", { status: 404 });
    const input = invoiceInputSchema.parse(await request.json());
    await requireProjectVisibleIf(ctx, input.projectId);
    const invoice = await updateInvoice(orgId, invoiceId, input);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "invoice.updated",
      entity: "invoice",
      entityId: invoiceId,
      ipAddress: getIpAddress(request),
    });
    return success(invoice);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const ctx = await gate(orgId, "FINANCE_MANAGE");
    if (ctx instanceof Response) return ctx;
    const existing = await prisma.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { projectId: true } });
    if (existing && !(await inVisibleProject(ctx, existing.projectId))) return new Response("Not found", { status: 404 });
    // Only a draft can be hard-deleted; an issued invoice must be voided (auditable).
    const deleted = await prisma.invoice.deleteMany({
      where: { id: invoiceId, orgId, status: "DRAFT" },
    });
    if (deleted.count === 0) {
      return new Response("Not found or not a draft", { status: 409 });
    }
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "invoice.deleted",
      entity: "invoice",
      entityId: invoiceId,
      ipAddress: getIpAddress(request),
    });
    return success({ id: invoiceId, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
