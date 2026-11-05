import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { ConflictError, requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { requireInvoiceVisible } from "@/lib/invoicing/visibility.server";
import { addReimbursables, listUnbilledReimbursables } from "@/lib/invoicing/reimbursables.server";

type RouteParams = { params: Promise<{ orgId: string; invoiceId: string }> };

/**
 * "Add reimbursables" on a draft invoice (src/lib/invoicing/reimbursables.server.ts).
 *
 * GET   the invoice's project's unbilled reimbursable costs, priced: FINANCE_READ.
 * POST  add them (all, or the ids given) as lines: FINANCE_MANAGE.
 * Both 404 an invoice on a project the caller can't see.
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

const bodySchema = z.strictObject({
  billIds: z.array(z.string().uuid()).max(500).optional(),
  expenseIds: z.array(z.string().uuid()).max(500).optional(),
});

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { org, ctx } = await load(orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);
    await requireInvoiceVisible(ctx, orgId, invoiceId);

    const inv = await prisma.invoice.findFirstOrThrow({ where: { id: invoiceId, orgId }, select: { status: true, projectId: true } });
    if (inv.status !== "DRAFT") throw new ConflictError("Only a draft invoice can take reimbursables");
    if (!inv.projectId) throw new ConflictError("Set the invoice's project before adding its reimbursables");
    return success(await listUnbilledReimbursables(orgId, inv.projectId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const { org, ctx } = await load(orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);
    await requireInvoiceVisible(ctx, orgId, invoiceId);

    const pick = bodySchema.parse(await request.json().catch(() => ({})));
    return success(await addReimbursables(orgId, invoiceId, pick));
  } catch (error) {
    return handleApiError(error);
  }
}
