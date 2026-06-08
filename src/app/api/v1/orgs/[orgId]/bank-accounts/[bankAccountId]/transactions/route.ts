import { NextRequest } from "next/server";
import { BankTxnStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { suggestCategories } from "@/lib/bank/reconcile";

type RouteParams = { params: Promise<{ orgId: string; bankAccountId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, bankAccountId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const account = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, orgId },
    });
    if (!account) return new Response("Not found", { status: 404 });

    const status =
      (request.nextUrl.searchParams.get("status") ?? "IMPORTED") as BankTxnStatus;

    const txns = await prisma.bankTransaction.findMany({
      where: { orgId, bankAccountId, status },
      orderBy: { postedDate: "desc" },
    });

    const suggestions = await suggestCategories(
      orgId,
      txns.map((t) => t.description),
    );
    const data = txns.map((t, i) => ({
      ...t,
      // A rule-set category (applied on import) wins over the leading-token heuristic.
      suggestedCategory: t.category ?? suggestions[i],
    }));

    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}
