import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getInvoice, updateInvoice } from "@/lib/invoicing/service";
import { invoiceInputSchema } from "@/lib/invoicing/validation";

type RouteParams = { params: Promise<{ orgId: string; invoiceId: string }> };

async function gate(orgId: string, permission: bigint): Promise<Response | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  requirePermission(ctx, permission);
  return null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const denied = await gate(orgId, Permission.FINANCE_READ);
    if (denied) return denied;
    const invoice = await getInvoice(orgId, invoiceId);
    if (!invoice) return new Response("Not found", { status: 404 });
    return success(invoice);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const denied = await gate(orgId, Permission.FINANCE_MANAGE);
    if (denied) return denied;
    const input = invoiceInputSchema.parse(await request.json());
    return success(await updateInvoice(orgId, invoiceId, input));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const denied = await gate(orgId, Permission.FINANCE_MANAGE);
    if (denied) return denied;
    // Only a draft can be hard-deleted; an issued invoice must be voided (auditable).
    const deleted = await prisma.invoice.deleteMany({
      where: { id: invoiceId, orgId, status: "DRAFT" },
    });
    if (deleted.count === 0) {
      return new Response("Not found or not a draft", { status: 409 });
    }
    return success({ id: invoiceId, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
