import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, success } from "@/lib/api-helpers";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { pendingMigrations } from "@/lib/workflow/migrate.server";
import { getWorkflowMigration } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(getWorkflowMigration, request, params);
    const auth = await workflowProjectContext(request, p, "read");
    if ("response" in auth) return auth.response;
    return success(await pendingMigrations(prisma, p.projectId));
  } catch (error) {
    return handleApiError(error, request);
  }
}
