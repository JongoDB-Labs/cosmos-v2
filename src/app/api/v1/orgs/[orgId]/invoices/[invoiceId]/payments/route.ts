import { NextRequest } from "next/server";
import { requireInvoiceVisible } from "@/lib/invoicing/visibility.server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { recordPayment } from "@/lib/invoicing/service";
import { paymentInputSchema } from "@/lib/invoicing/validation";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; invoiceId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_READ");
    await requireInvoiceVisible(ctx, orgId, invoiceId);

    const data = await prisma.payment.findMany({
      where: { orgId, invoiceId },
      orderBy: { receivedAt: "asc" },
    });
    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_MANAGE");
    await requireInvoiceVisible(ctx, orgId, invoiceId);

    const input = paymentInputSchema.parse(await request.json());
    const payment = await recordPayment(orgId, invoiceId, ctx.userId, input);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "invoice.payment_recorded",
      entity: "invoice",
      entityId: invoiceId,
      ipAddress: getIpAddress(request),
    });
    return success(payment);
  } catch (error) {
    return handleApiError(error);
  }
}
