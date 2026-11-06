import { NextRequest } from "next/server";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { visibleProjectRecordsWhere } from "@/lib/rbac/project-access";
import { handleApiError } from "@/lib/api-helpers";
import { orgContext } from "@/lib/openapi/org-context";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { unbilledReimbursablesByProject } from "@/lib/invoicing/reimbursables.server";
import { listUnbilledReimbursables } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * What is still to be re-billed, by project: the read behind any "unbilled"
 * report. Visibility is in the WHERE, so a project hidden from the caller is
 * never read; naming one is refused like any other project gate.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listUnbilledReimbursables);
    const {
      params: { orgId },
      query: { projectId },
    } = await parseRequest(listUnbilledReimbursables, request, params);
    requirePermission(ctx, Permission.FINANCE_READ);

    const scope = projectId
      ? (await requireProjectVisible(ctx, projectId), { projectId })
      : { visible: await visibleProjectRecordsWhere(ctx) };
    return respond(listUnbilledReimbursables, 200, await unbilledReimbursablesByProject(orgId, scope));
  } catch (error) {
    return handleApiError(error, request);
  }
}
