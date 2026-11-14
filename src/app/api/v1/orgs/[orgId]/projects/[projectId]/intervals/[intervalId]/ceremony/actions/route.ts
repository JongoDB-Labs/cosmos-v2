import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { addCeremonyAction } from "@/lib/intervals/ceremony.server";
import { ceremonyAuth, isResponse, routeCaller } from "../_helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

/**
 * Capture an action item; owner and due date are optional at this point. Gate
 * and work: addCeremonyAction in lib/intervals/ceremony.server.ts.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await addCeremonyAction(ctx, { orgId, projectId, intervalId }, () => request.json(), routeCaller(request)),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
