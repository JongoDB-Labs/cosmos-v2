import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { loadWorkItemComments, readableItemProjectId } from "@/lib/work-items/read.server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createWorkItemCommentById, listWorkItemCommentsById } from "./route.contract";
import { createComment } from "../../../projects/[projectId]/work-items/[itemId]/comments/route";

type RouteParams = { params: Promise<{ orgId: string; itemId: string }> };

/**
 * Org-scoped comments on a work item, for the same reason as the item route
 * beside it: the project is derivable from the item, so making a caller supply
 * it is busywork. The project-scoped route owns the mention parsing and the
 * notification fan-out; both call its `createComment`.
 */

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

/** Authenticates before it looks the item up, like the GET. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await orgContext((await params).orgId, createWorkItemCommentById);
    const { params: { orgId, itemId }, body } = await parseRequest(createWorkItemCommentById, request, params);
    // An item in a project the caller can't read is the same 404 as a missing id.
    const projectId = await readableItemProjectId(ctx, orgId, itemId, "COMMENT_READ");
    if (!projectId) return problem(404, "not_found", undefined, { request });
    return respond(createWorkItemCommentById, 201, await createComment(org, ctx, { orgId, projectId, itemId }, body));
  } catch (error) {
    return handleApiError(error, request);
  }
}
