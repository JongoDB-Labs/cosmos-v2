import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { updateCeremonyAction, deleteCeremonyAction } from "@/lib/intervals/ceremony.server";
import { ceremonyAuth, isResponse } from "../../_helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    intervalId: string;
    actionId: string;
  }>;
};

/** Edit an action item. Gate and work: lib/intervals/ceremony.server.ts. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, actionId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await updateCeremonyAction(ctx, { orgId, projectId, intervalId }, actionId, () => request.json()),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

/** Delete an action item; a work item already promoted from it stays. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, actionId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await deleteCeremonyAction(ctx, { orgId, projectId, intervalId }, actionId),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
