import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { handleApiError } from "@/lib/api-helpers";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { listWorkItemActivity } from "./route.contract";
import { projectActivityValues } from "@/lib/work-items/read.server";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listWorkItemActivity);
    const { params: { orgId, projectId, itemId } } = await parseRequest(listWorkItemActivity, request, params);
    await requireProjectRead(ctx, projectId, "ITEM_READ");

    const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!item) return problem(404, "not_found", undefined, { request });

    const activities = await prisma.activity.findMany({
      where: { workItemId: itemId, orgId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return respond(listWorkItemActivity, 200, projectActivityValues(activities));
  } catch (error) {
    return handleApiError(error, request);
  }
}
