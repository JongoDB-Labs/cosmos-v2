import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { updateBill } from "@/lib/payables/service";

type RouteParams = { params: Promise<{ orgId: string; billId: string }> };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const patchSchema = z.object({
  amountPaid: z.number().finite().nonnegative().optional(),
  status: z.enum(["DRAFT", "OPEN", "PAID", "VOID"]).optional(),
  paidDate: DATE.nullish(),
  dueDate: DATE.nullish(),
  terms: z.enum(["DUE_DATE", "PAY_WHEN_PAID"]).optional(),
  invoiceId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  notes: z.string().max(2000).nullish(),
});

/** Record a payment against a bill, or change what it belongs to. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, billId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const patch = patchSchema.parse(await request.json());
    const updated = await updateBill(orgId, billId, patch);
    if (!updated) return new Response("Not found", { status: 404 });
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
