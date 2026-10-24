import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import { loadWorkItemComments, readableItemProjectId } from "@/lib/work-items/read.server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { listWorkItemCommentsById } from "./route.contract";
import {
  POST as projectCommentsPost,
} from "../../../projects/[projectId]/work-items/[itemId]/comments/route";

type RouteParams = { params: Promise<{ orgId: string; itemId: string }> };

/**
 * Org-scoped comments on a work item, for the same reason as the item route
 * beside it: the project is derivable from the item, so making a caller supply
 * it is busywork. Delegates to the project-scoped handler, which owns the
 * mention parsing and the notification fan-out.
 */
async function resolve(params: RouteParams["params"]) {
  const { orgId, itemId } = await params;
  const item = await prisma.workItem.findFirst({
    where: { id: itemId, orgId },
    select: { projectId: true },
  });
  if (!item) return null;
  return { params: Promise.resolve({ orgId, projectId: item.projectId, itemId }) };
}

/** Authenticates before it looks the item up, like GET /work-items/{itemId}. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listWorkItemCommentsById);
    const { params: { orgId, itemId } } = await parseRequest(listWorkItemCommentsById, request, params);
    // An item in a project the caller can't read is the same 404 as a missing id.
    const projectId = await readableItemProjectId(ctx, orgId, itemId, "COMMENT_READ");
    if (!projectId) return problem(404, "not_found", undefined, { request });

    const comments = await loadWorkItemComments(ctx, orgId, projectId, itemId);
    if (!comments) return problem(404, "not_found", undefined, { request });
    return respond(listWorkItemCommentsById, 200, comments);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const target = await resolve(params);
    if (!target) return new Response("Not found", { status: 404 });
    return projectCommentsPost(request, target);
  } catch (error) {
    return handleApiError(error);
  }
}
