import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { sendInvoice } from "@/lib/invoicing/service";

const bodySchema = z.object({ issueDate: z.coerce.date().optional() });

type RouteParams = { params: Promise<{ orgId: string; invoiceId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invoiceId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    return success(await sendInvoice(orgId, invoiceId, ctx.userId, body.issueDate));
  } catch (error) {
    return handleApiError(error);
  }
}
