import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { ComplianceFramework, ControlStatus } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMPLIANCE_READ);

    const controls = await prisma.complianceControl.findMany({
      where: { orgId },
    });

    const allStatuses: ControlStatus[] = [
      "NOT_ASSESSED",
      "IN_PROGRESS",
      "IMPLEMENTED",
      "PARTIALLY_IMPLEMENTED",
      "NOT_APPLICABLE",
      "FAILED",
    ];

    const frameworks = Object.values(ComplianceFramework);
    const now = new Date();

    const byFramework = frameworks.reduce(
      (acc, fw) => {
        const fwControls = controls.filter((c) => c.framework === fw);
        if (fwControls.length === 0) return acc;

        const statusCounts = allStatuses.reduce(
          (sc, s) => {
            sc[s] = fwControls.filter((c) => c.status === s).length;
            return sc;
          },
          {} as Record<string, number>,
        );

        const total = fwControls.length;
        const implemented = statusCounts["IMPLEMENTED"] ?? 0;

        acc[fw] = {
          total,
          byStatus: statusCounts,
          percentImplemented: total > 0 ? Math.round((implemented / total) * 100) : 0,
        };

        return acc;
      },
      {} as Record<string, { total: number; byStatus: Record<string, number>; percentImplemented: number }>,
    );

    const total = controls.length;
    const implemented = controls.filter((c) => c.status === "IMPLEMENTED").length;
    const inProgress = controls.filter((c) => c.status === "IN_PROGRESS").length;
    const failed = controls.filter((c) => c.status === "FAILED").length;
    const notAssessed = controls.filter((c) => c.status === "NOT_ASSESSED").length;

    const overdueControls = controls.filter(
      (c) =>
        c.dueDate &&
        c.dueDate < now &&
        c.status !== "IMPLEMENTED" &&
        c.status !== "NOT_APPLICABLE",
    ).length;

    return success({
      byFramework,
      overall: {
        total,
        implemented,
        inProgress,
        failed,
        notAssessed,
      },
      overdueControls,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
