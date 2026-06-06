import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ACCOUNTING_READ);

    const take = Math.min(Number(request.nextUrl.searchParams.get("limit")) || 50, 200);
    const entries = await prisma.journalEntry.findMany({
      where: { orgId, status: "POSTED" },
      orderBy: { entryNumber: "desc" },
      take,
      include: {
        lines: {
          include: {
            account: { select: { code: true, name: true } },
          },
        },
      },
    });
    return success({ data: entries, total: entries.length });
  } catch (error) {
    return handleApiError(error);
  }
}
