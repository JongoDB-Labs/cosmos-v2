import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import type { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.AUDIT_LOG_READ);

    const page = Math.max(1, parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10)));
    const action = request.nextUrl.searchParams.get("action");
    const entity = request.nextUrl.searchParams.get("entity");
    const userId = request.nextUrl.searchParams.get("userId");
    const startDate = request.nextUrl.searchParams.get("startDate");
    const endDate = request.nextUrl.searchParams.get("endDate");

    const where: Prisma.AuditLogWhereInput = {
      orgId,
      ...(action ? { action } : {}),
      ...(entity ? { entity } : {}),
      ...(userId ? { userId } : {}),
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: new Date(startDate) } : {}),
              ...(endDate ? { lte: new Date(endDate) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        // Explicit projection: the AU-9 hash-chain columns must NOT be returned.
        // `seq` is a BigInt (JSON.stringify throws "Do not know how to serialize
        // a BigInt" → 500 for the whole viewer), and `rowHash`/`prevHash` are
        // internal WORM-verification bytes that shouldn't leak to the client.
        select: {
          id: true,
          orgId: true,
          userId: true,
          action: true,
          entity: true,
          entityId: true,
          metadata: true,
          ipAddress: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return success({ data, total, page, limit });
  } catch (error) {
    return handleApiError(error);
  }
}
