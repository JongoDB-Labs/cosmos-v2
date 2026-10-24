import { NextRequest } from "next/server";
import { handleApiError, success } from "@/lib/api-helpers";
import { parseRequest } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { runDueSchedules } from "@/lib/automation/engine.server";
import { tickAutomations } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Run this org's due scheduled rules now. The automation-schedules job does
 * this every minute; this is for an operator's scheduler (a `rules:run` key,
 * like rules/run). Each rule still runs as its owner, never as the key.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(tickAutomations, request, params);
    const { ctx } = await orgContext(p.orgId, tickAutomations);
    requirePermission(ctx, Permission.RULES_RUN);
    return success({ ran: await runDueSchedules({ orgId: p.orgId }) });
  } catch (error) {
    return handleApiError(error, request);
  }
}
