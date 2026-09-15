import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError } from "@/lib/api-helpers";
import {
  GET as projectCommentsGet,
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

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const target = await resolve(params);
    if (!target) return new Response("Not found", { status: 404 });
    return projectCommentsGet(request, target);
  } catch (error) {
    return handleApiError(error);
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
