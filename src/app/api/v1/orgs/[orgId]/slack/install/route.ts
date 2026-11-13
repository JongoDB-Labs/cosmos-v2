import { NextRequest, NextResponse } from "next/server";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { handleApiError } from "@/lib/api-helpers";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { SLACK_CALLBACK_PATH, SLACK_STATE_COOKIE, slackAppConfig } from "@/lib/integrations/slack/config";
import { newInstallState, slackAuthorizeUrl } from "@/lib/integrations/slack/oauth.server";
import { startSlackInstall } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * "Add to Slack": send an admin to Slack to install the instance's app into
 * their workspace. The redirect URI is this instance's public address (as the
 * request reached it), and the state cookie is sealed and good for 10 minutes.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const origin = getPublicOrigin(request);
    const { org, ctx } = await orgContext((await params).orgId, startSlackInstall);
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);
    const back = (slack: string) => NextResponse.redirect(new URL(`/${org.slug}/settings/integrations?slack=${slack}`, origin));

    if (!rateLimit(getRateLimitKey(request, "slack.install", ctx.userId), { capacity: 10, refillPerSecond: 0.1 }).allowed) {
      return back("rate_limited");
    }
    const app = slackAppConfig();
    if (!app) return back("not_configured");

    const s = newInstallState(org.id, ctx.userId, origin);
    const res = NextResponse.redirect(slackAuthorizeUrl({ clientId: app.clientId, redirectUri: `${origin}${SLACK_CALLBACK_PATH}`, state: s.state }));
    res.cookies.set(SLACK_STATE_COOKIE, s.cookie, {
      httpOnly: true,
      sameSite: "lax",
      path: SLACK_CALLBACK_PATH,
      maxAge: 10 * 60,
      // Any https deployment, not only NODE_ENV=production ones.
      secure: origin.startsWith("https:"),
    });
    return res;
  } catch (error) {
    return handleApiError(error, request);
  }
}
