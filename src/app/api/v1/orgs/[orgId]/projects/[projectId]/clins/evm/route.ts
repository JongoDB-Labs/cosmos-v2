import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { ForbiddenError } from "@/lib/rbac/check";
import { canSeeProjectMoney } from "@/lib/rbac/money-fields";
import { success, handleApiError } from "@/lib/api-helpers";
import { loadClinBurnTimePhased } from "@/lib/pm/burn";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "ANALYTICS_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    // Every figure here is money (ceiling, funding, burn, the curve), so there
    // is nothing left to return without it.
    if (!(await canSeeProjectMoney(ctx, projectId))) {
      throw new ForbiddenError("CLIN burn needs Finance access");
    }

    const evm = await loadClinBurnTimePhased(orgId, projectId);
    return success(evm);
  } catch (e) {
    return handleApiError(e);
  }
}
