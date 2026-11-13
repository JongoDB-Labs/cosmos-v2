import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { getIpAddress, handleApiError, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { configuredPublicOrigin } from "@/lib/integrations/microsoft/hosts";
import { SLACK_CALLBACK_PATH, SLACK_SCOPES, slackAppConfig } from "@/lib/integrations/slack/config";
import { disconnectSlack } from "@/lib/integrations/slack/install.server";
import { deleteSlackConnection, getSlackSetup } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/** Waiting first: those are the ones an admin has to act on. */
const ORDER = { NEEDS_REVIEW: 0, LINKED: 1, NO_MATCH: 2, UNLINKED: 3 } as const;

/**
 * For admins: what Slack notifications need, the org's connection and its
 * delivery health, and every member's link (shared Slack accounts first).
 * Never a token.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getSlackSetup);
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);
    const orgId = ctx.orgId;
    const [install, queued, rows, members] = await Promise.all([
      prisma.slackInstallation.findUnique({ where: { orgId } }),
      prisma.slackOutbox.count({ where: { orgId } }),
      prisma.slackUserLink.findMany({
        where: { orgId },
        select: { id: true, userId: true, status: true, slackUserId: true, approvedById: true, notifyTypes: true, user: { select: { displayName: true, email: true } } },
      }),
      prisma.orgMember.findMany({ where: { orgId }, select: { userId: true } }),
    ]);
    const current = new Set(members.map((m) => m.userId));
    const installer = install
      ? await prisma.user.findUnique({ where: { id: install.installedById }, select: { displayName: true, email: true } })
      : null;
    return success({
      appConfigured: !!slackAppConfig(),
      redirectUri: `${getPublicOrigin(request)}${SLACK_CALLBACK_PATH}`,
      scopes: [...SLACK_SCOPES],
      installation: install
        ? {
            teamId: install.teamId,
            teamName: install.teamName,
            installedBy: installer ? installer.displayName || installer.email : null,
            status: install.status === "ACTIVE" ? ("ACTIVE" as const) : ("ERROR" as const),
            lastDeliveredAt: install.lastDeliveredAt?.toISOString() ?? null,
            lastErrorAt: install.lastErrorAt?.toISOString() ?? null,
            lastErrorCode: install.lastErrorCode,
            queued,
            linkOrigin: configuredPublicOrigin() ?? install.publicOrigin,
          }
        : null,
      links: rows
        .filter((r) => current.has(r.userId))
        .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.slackUserId ?? "").localeCompare(b.slackUserId ?? ""))
        .map((r) => ({
          id: r.id,
          userId: r.userId,
          name: r.user.displayName || r.user.email,
          email: r.user.email,
          status: r.status,
          slackUserId: r.slackUserId,
          approved: !!r.approvedById,
          optedOut: r.notifyTypes.length === 0,
        })),
    });
  } catch (error) {
    return handleApiError(error, request);
  }
}

/** Disconnect: revoke at Slack (best effort), then delete the token and everything sent through it. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, deleteSlackConnection);
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);
    const r = await disconnectSlack(ctx.orgId);
    if (r.had) {
      await logAudit({
        orgId: ctx.orgId,
        userId: ctx.userId,
        action: "slack.disconnected",
        entity: "integration",
        metadata: { revoked: String(r.revoked), ...(r.revokeError ? { revokeError: r.revokeError } : {}) },
        ipAddress: getIpAddress(request),
      });
    }
    return success({ disconnected: r.had, revoked: r.revoked, revokeError: r.revokeError });
  } catch (error) {
    return handleApiError(error, request);
  }
}
