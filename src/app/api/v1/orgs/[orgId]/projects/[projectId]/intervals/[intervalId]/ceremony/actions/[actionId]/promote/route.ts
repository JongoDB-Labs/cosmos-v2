import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { promoteCeremonyAction } from "@/lib/intervals/ceremony.server";
import { ceremonyAuth, isResponse, routeCaller } from "../../../_helpers";

type RouteParams = {
  params: Promise<{
    orgId: string;
    projectId: string;
    intervalId: string;
    actionId: string;
  }>;
};

/**
 * Promote a retro action into real, tracked work: one click, idempotent. Gate
 * and work: promoteCeremonyAction in lib/intervals/ceremony.server.ts.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId, actionId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await promoteCeremonyAction(ctx, { orgId, projectId, intervalId }, actionId, routeCaller(request)),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
