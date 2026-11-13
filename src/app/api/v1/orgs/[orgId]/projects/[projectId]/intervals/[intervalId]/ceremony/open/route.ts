import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { openCeremony } from "@/lib/intervals/ceremony.server";
import { ceremonyAuth, isResponse, routeCaller } from "../_helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

/**
 * Open the ceremony for this board and sprint, creating it the first time;
 * re-opening a CLOSED one is allowed. Gate and work: openCeremony in
 * lib/intervals/ceremony.server.ts.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await openCeremony(ctx, { orgId, projectId, intervalId }, () => request.json(), routeCaller(request)),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
