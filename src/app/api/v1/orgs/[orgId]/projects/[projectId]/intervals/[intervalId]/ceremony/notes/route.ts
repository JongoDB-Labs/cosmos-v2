import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { addCeremonyNote } from "@/lib/intervals/ceremony.server";
import { ceremonyAuth, isResponse } from "../_helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

/**
 * Add a note to a retro column. Any project member may. Gate and work:
 * addCeremonyNote in lib/intervals/ceremony.server.ts.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await addCeremonyNote(ctx, { orgId, projectId, intervalId }, () => request.json()),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
