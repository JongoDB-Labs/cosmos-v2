import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { seedSystemCoA } from "@/lib/ledger/chart-of-accounts";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ACCOUNTING_READ);

    if ((await prisma.account.count({ where: { orgId } })) === 0) await seedSystemCoA(orgId);
    const accounts = await prisma.account.findMany({
      where: { orgId },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, type: true, normalBalance: true, isActive: true, parentId: true },
    });
    return success({ data: accounts, total: accounts.length });
  } catch (error) {
    return handleApiError(error);
  }
}
