import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { postPayRun } from "@/lib/payroll/service";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; payRunId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, payRunId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_MANAGE");

    const result = await postPayRun(orgId, payRunId, ctx.userId);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "pay_run.posted",
      entity: "pay_run",
      entityId: payRunId,
      // A count of entries left out for want of a cost rate; never the rate or the total.
      metadata: { skippedEntries: result.unpricedSkipped },
      ipAddress: getIpAddress(request),
    });
    return success(result);
  } catch (error) {
    return handleApiError(error);
  }
}
