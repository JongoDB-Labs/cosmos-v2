import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { updateCeremonyNote, deleteCeremonyNote } from "@/lib/intervals/ceremony.server";
import { ceremonyAuth, isResponse, routeCaller } from "../../_helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    intervalId: string;
    noteId: string;
  }>;
};

/**
 * Editing and deleting a note are the author's, with the facilitator able to
 * remove anything. Gate and work: lib/intervals/ceremony.server.ts.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, noteId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await updateCeremonyNote(ctx, { orgId, projectId, intervalId }, noteId, () => request.json(), routeCaller(request)),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, noteId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await deleteCeremonyNote(ctx, { orgId, projectId, intervalId }, noteId, routeCaller(request)),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
