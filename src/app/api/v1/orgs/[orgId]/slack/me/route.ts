import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getIpAddress, handleApiError, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { orgContext } from "@/lib/openapi/org-context";
import { ProblemError } from "@/lib/openapi/problem";
import { parseRequest } from "@/lib/openapi/respond";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { SLACK_NOTIFY_TYPES, isSlackNotifyType } from "@/lib/integrations/slack/config";
import { recordSlackFailure, slackBotToken } from "@/lib/integrations/slack/install.server";
import { matchMember, setNotifyTypes, unlinkMember, type MatchResult } from "@/lib/integrations/slack/links.server";
import { SlackApiError } from "@/lib/integrations/slack/web-api.server";
import { getMySlackLink, linkMySlackAccount, unlinkMySlackAccount, updateMySlackNotifications } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The signed-in member's own Slack link in this org: see it, choose what
 * comes to Slack (none = opted out), link now, or unlink. Only their own row;
 * an admin's view of everyone is GET /slack. Like the bell and Teams, for
 * people whose role reads notifications (NOTIFICATION_READ).
 */
async function view(orgId: string, userId: string, reason: MatchResult["reason"] | null = null) {
  const [install, link] = await Promise.all([
    prisma.slackInstallation.findUnique({ where: { orgId }, select: { status: true, teamName: true } }),
    prisma.slackUserLink.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { status: true, notifyTypes: true } }),
  ]);
  const status = link?.status ?? null;
  return {
    available: !!install,
    workspace: install?.teamName ?? null,
    status,
    reason: reason ?? (status === "NEEDS_REVIEW" ? "conflict" : status === "UNLINKED" ? "unlinked" : null),
    notifyTypes: link ? link.notifyTypes.filter(isSlackNotifyType) : [...SLACK_NOTIFY_TYPES],
  };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getMySlackLink);
    requirePermission(ctx, Permission.NOTIFICATION_READ);
    return success(await view(ctx.orgId, ctx.userId));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const raw = await params;
    const { ctx } = await orgContext(raw.orgId, updateMySlackNotifications);
    requirePermission(ctx, Permission.NOTIFICATION_READ);
    const { body } = await parseRequest(updateMySlackNotifications, request, raw);
    await setNotifyTypes(ctx.orgId, ctx.userId, body.notifyTypes);
    return success(await view(ctx.orgId, ctx.userId));
  } catch (error) {
    return handleApiError(error, request);
  }
}

/** Link now: look the member up by their Cosmos email (also after an unlink). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, linkMySlackAccount);
    requirePermission(ctx, Permission.NOTIFICATION_READ);
    if (!rateLimit(getRateLimitKey(request, "slack.link", ctx.userId), { capacity: 5, refillPerSecond: 1 / 12 }).allowed) {
      throw new ProblemError(429, "rate_limited", "Wait a minute before trying again.");
    }
    const token = await slackBotToken(ctx.orgId);
    if (!token) throw new ProblemError(409, "conflict", "Slack isn't connected for this organization.");
    let r: MatchResult;
    try {
      r = await matchMember({ orgId: ctx.orgId, userId: ctx.userId, token: token.token, teamId: token.teamId, relinkUnlinked: true });
    } catch (e) {
      if (!(e instanceof SlackApiError)) throw e;
      await recordSlackFailure(ctx.orgId, e, new Date());
      throw new ProblemError(409, "conflict", `Slack didn't answer the lookup (${e.code}). Try again later.`);
    }
    await logAudit({
      orgId: ctx.orgId, userId: ctx.userId, action: "slack.linked", entity: "user", entityId: ctx.userId,
      metadata: { status: r.status }, ipAddress: getIpAddress(request),
    });
    return success(await view(ctx.orgId, ctx.userId, r.reason ?? null));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, unlinkMySlackAccount);
    requirePermission(ctx, Permission.NOTIFICATION_READ);
    await unlinkMember(ctx.orgId, ctx.userId);
    await logAudit({
      orgId: ctx.orgId, userId: ctx.userId, action: "slack.unlinked", entity: "user", entityId: ctx.userId, ipAddress: getIpAddress(request),
    });
    return success(await view(ctx.orgId, ctx.userId));
  } catch (error) {
    return handleApiError(error, request);
  }
}
