import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { createInvoice, listInvoices } from "@/lib/invoicing/service";
import { invoiceInputSchema } from "@/lib/invoicing/validation";
import { requireProjectVisible, requireProjectVisibleIf } from "@/lib/rbac/require-project-read";
import { visibleProjectRecordsWhere } from "@/lib/rbac/project-access";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const status = request.nextUrl.searchParams.get("status") ?? undefined;
    const projectId = request.nextUrl.searchParams.get("projectId") || undefined;
    // Asking about one project: it must be one the caller can see. Otherwise an
    // invoice on a project hidden from the caller is left out of the list, the
    // way that project's expenses are.
    if (projectId) await requireProjectVisible(ctx, projectId);
    const data = await listInvoices(orgId, { status, projectId, visible: await visibleProjectRecordsWhere(ctx) });
    return success({ data, total: data.length });
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
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const input = invoiceInputSchema.parse(await request.json());
    // Billing a project is writing to it.
    await requireProjectVisibleIf(ctx, input.projectId);
    return success(await createInvoice(orgId, ctx.userId, input));
  } catch (error) {
    return handleApiError(error);
  }
}
