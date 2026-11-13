import { NextRequest } from "next/server";
import { getIpAddress, handleApiError, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { orgContext } from "@/lib/openapi/org-context";
import { ProblemError } from "@/lib/openapi/problem";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { recordSlackFailure, slackBotToken } from "@/lib/integrations/slack/install.server";
import { matchAllMembers } from "@/lib/integrations/slack/links.server";
import { SlackApiError } from "@/lib/integrations/slack/web-api.server";
import { matchSlackMembers } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/** An admin's "Match members by email". */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, matchSlackMembers);
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);
    if (!rateLimit(getRateLimitKey(request, "slack.match", ctx.userId), { capacity: 3, refillPerSecond: 1 / 20 }).allowed) {
      throw new ProblemError(429, "rate_limited", "Wait a minute before matching again.");
    }
    const token = await slackBotToken(ctx.orgId);
    if (!token) throw new ProblemError(409, "conflict", "Slack isn't connected for this organization.");
    let r;
    try {
      r = await matchAllMembers({ orgId: ctx.orgId, token: token.token, teamId: token.teamId });
    } catch (e) {
      if (!(e instanceof SlackApiError)) throw e;
      await recordSlackFailure(ctx.orgId, e, new Date());
      throw new ProblemError(409, "conflict", `Slack refused the lookup (${e.code}).`);
    }
    await logAudit({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "slack.members_matched",
      entity: "integration",
      metadata: { linked: String(r.linked), review: String(r.review), notFound: String(r.notFound), remaining: String(r.remaining) },
      ipAddress: getIpAddress(request),
    });
    return success(r);
  } catch (error) {
    return handleApiError(error, request);
  }
}
