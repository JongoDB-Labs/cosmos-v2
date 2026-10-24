import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, success } from "@/lib/api-helpers";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { pendingMigrations } from "@/lib/workflow/migrate.server";
import { getWorkflowMigration } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(getWorkflowMigration, request, params);
    const ctx = await workflowProjectContext(p, getWorkflowMigration);
    await requireProjectRead(ctx, p.projectId, "ITEM_READ");
    return success(await pendingMigrations(prisma, p.projectId));
  } catch (error) {
    return handleApiError(error, request);
  }
}
