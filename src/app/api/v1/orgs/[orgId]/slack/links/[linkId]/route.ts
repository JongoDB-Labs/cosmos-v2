import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getIpAddress, handleApiError, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { orgContext } from "@/lib/openapi/org-context";
import { ProblemError } from "@/lib/openapi/problem";
import { parseRequest } from "@/lib/openapi/respond";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { approveLink, unlinkMember } from "@/lib/integrations/slack/links.server";
import { updateSlackLink } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; linkId: string }> };

/**
 * An admin approves a member who shares a Slack account with another member
 * (until then nothing is sent to them), or removes a member's link. Never
 * their own: allowing a link sends that member's notifications to whoever
 * owns the Slack account, so someone else must decide it.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const raw = await params;
    const { ctx } = await orgContext(raw.orgId, updateSlackLink);
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);
    const { params: p, body } = await parseRequest(updateSlackLink, request, raw);
    const link = await prisma.slackUserLink.findFirst({ where: { id: p.linkId, orgId: ctx.orgId }, select: { id: true, userId: true, slackUserId: true } });
    if (!link) throw new ProblemError(404, "not_found", "No such Slack link");
    if (body.action === "approve") {
      if (link.userId === ctx.userId) {
        throw new ProblemError(403, "forbidden", "You can't allow your own link. Ask another admin.");
      }
      if (!(await approveLink(ctx.orgId, link.id, ctx.userId))) {
        throw new ProblemError(409, "conflict", "Only a link waiting for review can be approved.");
      }
    } else {
      await unlinkMember(ctx.orgId, link.userId);
    }
    await logAudit({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: body.action === "approve" ? "slack.link_approved" : "slack.link_removed",
      entity: "user",
      entityId: link.userId,
      metadata: { slackUserId: link.slackUserId ?? "" },
      ipAddress: getIpAddress(request),
    });
    return success({ ok: true as const });
  } catch (error) {
    return handleApiError(error, request);
  }
}
