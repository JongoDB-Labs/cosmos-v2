import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { getCeremonyPayload } from "@/lib/intervals/ceremony.server";
import { ceremonyAuth, isResponse } from "./_helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; intervalId: string }>;
};

/**
 * Everything a sprint ceremony board renders, in ONE request. The gate and the
 * work are in lib/intervals/ceremony.server.ts (getCeremonyPayload), shared
 * with the assistant's get_ceremony tool.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const ctx = await ceremonyAuth(orgId);
    if (isResponse(ctx)) return ctx;

    return success(
      await getCeremonyPayload(ctx, { orgId, projectId, intervalId }, {
        boardId: request.nextUrl.searchParams.get("boardId"),
        teamId: request.nextUrl.searchParams.get("teamId"),
      }),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
