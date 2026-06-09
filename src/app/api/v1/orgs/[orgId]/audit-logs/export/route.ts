import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.AUDIT_LOG_READ);

    // Mirror the list route's filters EXACTLY so an export honors the same
    // action/entity/user/date filters the viewer has applied — otherwise an
    // export taken with filters active silently returns the broader, unfiltered
    // set (a compliance-reporting hazard).
    const action = request.nextUrl.searchParams.get("action");
    const entity = request.nextUrl.searchParams.get("entity");
    const userId = request.nextUrl.searchParams.get("userId");
    const startDate = request.nextUrl.searchParams.get("startDate");
    const endDate = request.nextUrl.searchParams.get("endDate");
    const format = request.nextUrl.searchParams.get("format") ?? "json";

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

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    if (format === "csv") {
      const header = "timestamp,userId,action,entity,entityId,ipAddress,metadata";
      const rows = logs.map((log) => {
        const meta = JSON.stringify(log.metadata).replace(/"/g, '""');
        return [
          log.createdAt.toISOString(),
          log.userId ?? "",
          log.action,
          log.entity,
          log.entityId ?? "",
          log.ipAddress ?? "",
          `"${meta}"`,
        ].join(",");
      });

      const csv = [header, ...rows].join("\n");

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="audit-logs-${orgId}.csv"`,
        },
      });
    }

    return new Response(JSON.stringify(logs), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
