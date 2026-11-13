import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { SLACK_CALLBACK_PATH, SLACK_STATE_COOKIE, slackAppConfig } from "@/lib/integrations/slack/config";
import { openInstallState, SlackInstallRefused } from "@/lib/integrations/slack/oauth.server";
import { completeSlackInstall } from "@/lib/integrations/slack/install.server";
import { SlackApiError } from "@/lib/integrations/slack/web-api.server";

/**
 * Where Slack sends an admin back after "Add to Slack": the redirect URL the
 * Slack app registers. The CSRF check: the state must match its sealed
 * cookie, be unexpired and unused, and belong to the person signed in now.
 * That person is resolved the way every org route resolves them
 * (getAuthContext), so the org's own sign-in rules hold here too: Require-MFA,
 * the idle timeout and the IP allowlist. They must still manage integrations
 * in that org. Only then is the code traded for the bot token, which is
 * sealed and never leaves the server.
 */
export async function GET(request: NextRequest) {
  const origin = getPublicOrigin(request);
  const url = new URL(request.url);
  const to = (path: string) => {
    const res = NextResponse.redirect(new URL(path, origin));
    res.cookies.set(SLACK_STATE_COOKIE, "", { path: SLACK_CALLBACK_PATH, maxAge: 0 });
    return res;
  };
  const done = (slug: string | null, slack: string) => to(slug ? `/${slug}/settings/integrations?slack=${slack}` : "/");

  const s = openInstallState(request.cookies.get(SLACK_STATE_COOKIE)?.value, url.searchParams.get("state"));
  if (!s) return done(null, "invalid_state");
  const org = await prisma.organization.findUnique({ where: { id: s.orgId }, select: { id: true, slug: true } });
  if (!org) return done(null, "invalid_state");
  const ctx = await getAuthContext(org.slug);
  // Signed out, or in a way this org doesn't accept (or with an API key, which
  // no browser redirect carries): sign in, then Add to Slack again.
  if (!ctx || ctx.isApiKey) return to("/login");
  if (ctx.userId !== s.userId) return done(null, "invalid_state");
  if (!hasPermission(ctx.permissions, Permission.INTEGRATION_MANAGE)) return done(org.slug, "forbidden");
  if (url.searchParams.get("error")) return done(org.slug, "denied");
  const code = url.searchParams.get("code");
  const app = slackAppConfig();
  if (!code) return done(org.slug, "invalid_state");
  if (!app) return done(org.slug, "not_configured");

  try {
    const grant = await completeSlackInstall(app, {
      orgId: org.id,
      userId: ctx.userId,
      code,
      // Exactly the redirect URI the authorize step used, as Slack requires.
      redirectUri: `${s.origin}${SLACK_CALLBACK_PATH}`,
      publicOrigin: s.origin,
    });
    await logAudit({
      orgId: org.id,
      userId: ctx.userId,
      action: "slack.connected",
      entity: "integration",
      metadata: { teamId: grant.teamId, scopes: grant.scopes.join(",") },
      ipAddress: getIpAddress(request),
    });
    return done(org.slug, "connected");
  } catch (e) {
    if (e instanceof SlackInstallRefused) {
      console.warn(`[slack] install for org ${org.id} refused (${e.code}): ${e.message}`);
      return done(org.slug, e.code);
    }
    console.warn(`[slack] install for org ${org.id} failed: ${e instanceof SlackApiError ? e.code : e instanceof Error ? e.message : "unknown error"}`);
    return done(org.slug, "failed");
  }
}
