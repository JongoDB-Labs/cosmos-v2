import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.AUDIT_LOG_READ);

    const startDate = request.nextUrl.searchParams.get("startDate");
    const endDate = request.nextUrl.searchParams.get("endDate");
    const format = request.nextUrl.searchParams.get("format") ?? "json";

    const logs = await prisma.auditLog.findMany({
      where: {
        orgId,
        ...(startDate || endDate
          ? {
              createdAt: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {}),
              },
            }
          : {}),
      },
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
