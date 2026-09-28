import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { listBills, createBill } from "@/lib/payables/service";

type RouteParams = { params: Promise<{ orgId: string }> };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const billInputSchema = z.object({
  reference: z.string().min(1).max(120),
  vendorName: z.string().min(1).max(200),
  amount: z.number().finite().nonnegative(),
  partnerId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  invoiceId: z.string().uuid().nullish(),
  status: z.enum(["DRAFT", "OPEN", "PAID", "VOID"]).optional(),
  terms: z.enum(["DUE_DATE", "PAY_WHEN_PAID"]).optional(),
  issueDate: DATE.nullish(),
  dueDate: DATE.nullish(),
  notes: z.string().max(2000).nullish(),
});

/** What the practice owes, with the summary computed over the same set. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const sp = request.nextUrl.searchParams;
    return success(
      await listBills(orgId, {
        status: sp.get("status") ?? undefined,
        projectId: sp.get("projectId") ?? undefined,
        partnerId: sp.get("partnerId") ?? undefined,
        invoice: sp.get("invoice") ?? undefined,
      }),
    );
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

    const input = billInputSchema.parse(await request.json());
    return success(await createBill(orgId, ctx.userId, input), 201);
  } catch (error) {
    return handleApiError(error);
  }
}
