import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import { loadWorkItemDetail, readableItemProjectId } from "@/lib/work-items/read.server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { getWorkItemById } from "./route.contract";
import {
  PUT as projectItemPut,
  DELETE as projectItemDelete,
} from "../../projects/[projectId]/work-items/[itemId]/route";

type RouteParams = { params: Promise<{ orgId: string; itemId: string }> };

/**
 * Org-scoped single work item: `/api/v1/orgs/{orgId}/work-items/{itemId}`.
 *
 * A work item's id is unique org-wide, so requiring its project in the path is
 * asking the caller for something the server already knows. For a browser that
 * cost nothing — it had the project in hand. For a script or an API key holder
 * it meant a lookup before every write, which is what made "work the board
 * without a browser" awkward enough to report.
 *
 * Every write here resolves the project and hands off to the project-scoped
 * route. That route stays the only implementation: it owns the activity trail,
 * the re-parent bookkeeping, the done-column capture and the RBAC gate, and a
 * second copy of those would drift. This adds an address, not behaviour. The
 * read shares its loader with that route instead (lib/work-items/read.server).
 *
 * PATCH and PUT are the same handler deliberately. PUT is what the app itself
 * sends; PATCH is the verb a partial update is usually reached for, and the
 * underlying handler has always been a partial update — every field on its
 * schema is optional, and it only writes what is present.
 */
async function resolve(params: RouteParams["params"]) {
  const { orgId, itemId } = await params;
  const item = await prisma.workItem.findFirst({
    where: { id: itemId, orgId },
    select: { projectId: true },
  });
  if (!item) return null;
  // Scoped by orgId above, so this cannot reach another tenant's item.
  return { params: Promise.resolve({ orgId, projectId: item.projectId, itemId }) };
}

/**
 * A read goes through the shared loader rather than the project route, so it
 * authenticates before it looks the item up: an unauthenticated caller gets
 * the same 401 whether or not the id exists. A signed-in caller who can't read
 * the item's project gets the same 404 as for a missing id.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getWorkItemById);
    const { params: { orgId, itemId } } = await parseRequest(getWorkItemById, request, params);
    // An item in a project the caller can't read is the same 404 as a missing id.
    const projectId = await readableItemProjectId(ctx, orgId, itemId, "ITEM_READ");
    if (!projectId) return problem(404, "not_found", undefined, { request });

    const item = await loadWorkItemDetail(ctx, orgId, projectId, itemId);
    if (!item) return problem(404, "not_found", undefined, { request });
    return respond(getWorkItemById, 200, item);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const target = await resolve(params);
    if (!target) return new Response("Not found", { status: 404 });
    return projectItemPut(request, target);
  } catch (error) {
    return handleApiError(error);
  }
}

export { PATCH as PUT };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const target = await resolve(params);
    if (!target) return new Response("Not found", { status: 404 });
    return projectItemDelete(request, target);
  } catch (error) {
    return handleApiError(error);
  }
}
