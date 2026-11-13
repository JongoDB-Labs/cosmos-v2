import { NextRequest } from "next/server";
import { success, handleApiError } from "@/lib/api-helpers";
import { orgContext } from "@/lib/openapi/org-context";
import { parseRequest } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { loadOutlookOverlay } from "@/lib/program-calendar/outlook.server";
import { OUTLOOK_MAX_WINDOW_DAYS } from "@/lib/program-calendar/overlays";
import { DAY_MS } from "@/lib/program-calendar/time";
import { listOutlookOverlay } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The caller's own Outlook events for one calendar window.
 *
 * Whose calendar is never a parameter: it is `ctx.userId`, the session's own
 * user. The contract's query schema has no field for a person, and nothing
 * else in the request is read.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listOutlookOverlay);
    const { query } = await parseRequest(listOutlookOverlay, request, params);
    const from = new Date(query.from);
    const to = new Date(query.to);
    // A month view asks for six weeks and a day either side. The bound keeps
    // one request to a handful of Graph pages.
    if (!(to > from) || to.getTime() - from.getTime() > OUTLOOK_MAX_WINDOW_DAYS * DAY_MS) {
      return problem(400, "invalid_request", `from must be before to, at most ${OUTLOOK_MAX_WINDOW_DAYS} days apart`, { request });
    }
    return success(await loadOutlookOverlay(ctx.orgId, ctx.userId, { from, to }));
  } catch (error) {
    return handleApiError(error, request);
  }
}
