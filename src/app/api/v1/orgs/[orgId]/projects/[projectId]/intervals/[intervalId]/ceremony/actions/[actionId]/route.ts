import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";
import {
  requireContributor,
  isResponse,
  publishCeremonyChanged,
} from "../../_helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    intervalId: string;
    actionId: string;
  }>;
};

const patchSchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  ownerId: z.string().uuid().nullish(),
  dueDate: z.coerce.date().nullish(),
});

/** Scoped lookup — an action ID alone must not reach another tenant's ceremony. */
async function loadAction(
  actionId: string,
  scope: { orgId: string; projectId: string; intervalId: string }
) {
  return prisma.retroActionItem.findFirst({
    where: {
      id: actionId,
      ceremony: {
        orgId: scope.orgId,
        intervalId: scope.intervalId,
        board: { projectId: scope.projectId },
      },
    },
    select: {
      id: true,
      ceremonyId: true,
      workItemId: true,
      ceremony: { select: { status: true } },
    },
  });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, actionId } = await params;
    const loaded = await requireContributor(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;

    const action = await loadAction(actionId, { orgId, projectId, intervalId });
    if (!action) return new Response("Action item not found", { status: 404 });
    if (action.ceremony.status === "CLOSED") {
      return new Response(JSON.stringify({ error: "This ceremony is closed" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = patchSchema.parse(await request.json());
    const updated = await prisma.retroActionItem.update({
      where: { id: action.id },
      data: {
        ...(data.text !== undefined ? { text: data.text } : {}),
        ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
        ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
      },
    });

    publishCeremonyChanged(orgId, action.ceremonyId);
    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, actionId } = await params;
    const loaded = await requireContributor(orgId, projectId, intervalId);
    if (isResponse(loaded)) return loaded;

    const action = await loadAction(actionId, { orgId, projectId, intervalId });
    if (!action) return new Response("Action item not found", { status: 404 });

    // Deleting the action does NOT delete a work item already promoted from it:
    // the team committed to that work, and it now lives in the backlog on its
    // own terms.
    await prisma.retroActionItem.delete({ where: { id: action.id } });

    publishCeremonyChanged(orgId, action.ceremonyId);
    return success({ id: action.id, promotedWorkItemId: action.workItemId });
  } catch (e) {
    return handleApiError(e);
  }
}
