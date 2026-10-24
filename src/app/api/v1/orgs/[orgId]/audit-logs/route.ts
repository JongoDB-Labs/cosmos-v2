import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import type { Prisma } from "@prisma/client";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { listAuditLogs } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listAuditLogs);
    const { params: { orgId }, query } = await parseRequest(listAuditLogs, request, params);
    requirePermission(ctx, Permission.AUDIT_LOG_READ);

    const { page, limit, action, entity, userId, startDate, endDate } = query;

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

    return respond(listAuditLogs, 200, { data, total, page, limit });
  } catch (error) {
    return handleApiError(error, request);
  }
}
