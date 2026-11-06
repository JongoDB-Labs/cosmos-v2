import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { handleApiError } from "@/lib/api-helpers";
import { orgContext } from "@/lib/openapi/org-context";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { unbilledReimbursablesByProject } from "@/lib/invoicing/reimbursables.server";
import { listProjectUnbilledReimbursables } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/** One project's unbilled reimbursable costs; see /orgs/{orgId}/unbilled-reimbursables. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listProjectUnbilledReimbursables);
    const {
      params: { orgId, projectId },
    } = await parseRequest(listProjectUnbilledReimbursables, request, params);
    await requireProjectRead(ctx, projectId, "FINANCE_READ");

    const { projects, lines } = await unbilledReimbursablesByProject(orgId, { projectId });
    const found = projects[0];
    if (found) return respond(listProjectUnbilledReimbursables, 200, { ...found, lines });
    // Nothing unbilled: the same shape, empty, so a caller needn't special-case it.
    const p = await prisma.project.findFirstOrThrow({ where: { id: projectId, orgId }, select: { key: true, name: true } });
    return respond(listProjectUnbilledReimbursables, 200, {
      projectId,
      projectKey: p.key,
      projectName: p.name,
      items: [],
      totals: { count: 0, cost: 0, markup: 0, total: 0 },
      lines,
    });
  } catch (error) {
    return handleApiError(error, request);
  }
}
