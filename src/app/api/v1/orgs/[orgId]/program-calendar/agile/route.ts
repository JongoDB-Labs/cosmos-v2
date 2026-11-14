import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { orgContext } from "@/lib/openapi/org-context";
import { parseRequest } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { loadAgileOverlay } from "@/lib/program-calendar/agile.server";
import { MAX_WINDOW_DAYS } from "@/lib/program-calendar/overlays";
import { DAY_MS } from "@/lib/program-calendar/time";
import { listAgileOverlay } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The Agile overlay for one calendar window.
 *
 * No permission is checked here beyond being a member: each kind of row is
 * gated by its own action inside `loadAgileOverlay` (SPRINT_READ for
 * intervals, ITEM_READ for work items), per project, so someone who may read
 * one and not the other gets the half they may read rather than a 403 for both.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listAgileOverlay);
    const { query } = await parseRequest(listAgileOverlay, request, params);
    const from = new Date(query.from);
    const to = new Date(query.to);
    // A month view asks for six weeks; a year is the most any view needs. The
    // bound keeps one request from reading every work item the org ever dated.
    if (!(to > from) || to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      return problem(400, "invalid_request", `from must be before to, at most ${MAX_WINDOW_DAYS} days apart`, { request });
    }
    return success(await loadAgileOverlay(ctx, { from, to, projectId: query.projectId }));
  } catch (error) {
    return handleApiError(error, request);
  }
}
