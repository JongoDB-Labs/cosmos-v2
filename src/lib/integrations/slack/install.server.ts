import { prisma } from "@/lib/db/client";
import { deleteOrgCredential, getOrgCredential, setOrgCredential } from "@/lib/integrations/credentials";
import { SLACK_NOTIFY, type SlackAppConfig } from "./config";
import { exchangeInstallCode, SlackInstallRefused, type SlackGrant } from "./oauth.server";
import { SlackApiError, slackApi, type SlackDeps } from "./web-api.server";

/**
 * An org's Slack install: the bot token, sealed in the connector-credential
 * store under SLACK_NOTIFY (org-level), and its visible half, the
 * slack_installations row (workspace, who, delivery health).
 */

/** The org's bot token, if Slack is connected and the token still works. */
export async function slackBotToken(orgId: string): Promise<{ token: string; teamId: string } | null> {
  const install = await prisma.slackInstallation.findUnique({ where: { orgId }, select: { status: true, teamId: true } });
  if (!install || install.status !== "ACTIVE") return null;
  const bundle = await getOrgCredential(orgId, SLACK_NOTIFY);
  return bundle?.botToken ? { token: bundle.botToken, teamId: install.teamId } : null;
}

const WORKSPACE_TAKEN = "This Slack workspace is already connected to another Cosmos organization. Disconnect it there first.";

/**
 * The OAuth callback's work: trade the code, seal the token, record the
 * install. Moving the org to a different workspace forgets every member's
 * match (their choices stay), since those Slack users belong to the old one,
 * and revokes the old workspace's token, which nothing uses any more.
 *
 * One Cosmos org per Slack workspace: Slack hands the same app the same bot
 * token for a workspace, so two orgs on one would share it, and either one's
 * disconnect would revoke it for both. A workspace another org holds is
 * refused (also by a unique index, for two installs racing), and the token
 * Slack just handed back is NOT revoked: it is the other org's token too.
 */
export async function completeSlackInstall(
  app: SlackAppConfig,
  o: { orgId: string; userId: string; code: string; redirectUri: string; publicOrigin: string },
  deps?: SlackDeps,
): Promise<SlackGrant> {
  const grant = await exchangeInstallCode(app, { code: o.code, redirectUri: o.redirectUri }, deps);
  const holder = await prisma.slackInstallation.findFirst({ where: { teamId: grant.teamId, orgId: { not: o.orgId } }, select: { id: true } });
  if (holder) throw new SlackInstallRefused("workspace_taken", WORKSPACE_TAKEN);

  const before = await prisma.slackInstallation.findUnique({ where: { orgId: o.orgId }, select: { teamId: true } });
  // Only a move to a different workspace retires the old token: for the same
  // one, Slack just returned this very token, and revoking it would cut off
  // the new install. Read it before it's replaced.
  const moving = !!before && before.teamId !== grant.teamId;
  const oldToken = moving ? ((await getOrgCredential(o.orgId, SLACK_NOTIFY).catch(() => null))?.botToken ?? null) : null;
  const data = {
    teamId: grant.teamId,
    teamName: grant.teamName,
    botUserId: grant.botUserId,
    appId: grant.appId,
    scopes: grant.scopes,
    installedById: o.userId,
    publicOrigin: o.publicOrigin,
    status: "ACTIVE",
    lastErrorAt: null,
    lastErrorCode: null,
  };
  // The install row first, then the token: losing a race to another org
  // leaves nothing of this attempt behind.
  try {
    await prisma.slackInstallation.upsert({ where: { orgId: o.orgId }, create: { orgId: o.orgId, ...data }, update: data });
  } catch (e) {
    if ((e as { code?: unknown })?.code === "P2002") throw new SlackInstallRefused("workspace_taken", WORKSPACE_TAKEN);
    throw e;
  }
  try {
    await setOrgCredential(o.orgId, SLACK_NOTIFY, { botToken: grant.botToken }, { teamId: grant.teamId, scopes: grant.scopes });
  } catch (e) {
    // The row names the new workspace but the token couldn't be stored: send
    // nothing (not with the old workspace's token) until the admin tries again.
    await prisma.slackInstallation.updateMany({ where: { orgId: o.orgId }, data: { status: "ERROR", lastErrorAt: new Date(), lastErrorCode: "token_not_stored" } });
    throw e;
  }
  if (moving) {
    await forgetMatches(o.orgId);
    if (oldToken) await revokeReplacedToken(o.orgId, oldToken, deps);
  }
  // Reconnecting is also how an admin says "try those people again".
  await prisma.slackUserLink.updateMany({ where: { orgId: o.orgId, status: "NO_MATCH" }, data: { checkedAt: null } });
  return grant;
}

/** Best effort: the new install stands either way, and the outcome is logged. */
async function revokeReplacedToken(orgId: string, token: string, deps?: SlackDeps) {
  try {
    await slackApi("auth.revoke", { bearer: token }, {}, deps);
    console.info(`[slack] org ${orgId}: moved to another workspace; the previous workspace's token was revoked`);
  } catch (e) {
    console.warn(
      `[slack] org ${orgId}: moved to another workspace, but revoking the previous workspace's token failed: ${e instanceof SlackApiError ? e.code : "unknown_error"}. Remove the app from that workspace in Slack.`,
    );
  }
}

/**
 * Every member's Slack match goes, but not what they chose: an unlink stays
 * an unlink and an opt-out stays an opt-out, for whatever workspace comes next.
 */
async function forgetMatches(orgId: string) {
  await prisma.slackUserLink.updateMany({
    where: { orgId, status: { in: ["LINKED", "NEEDS_REVIEW", "NO_MATCH"] } },
    data: { status: "NO_MATCH", slackTeamId: null, slackUserId: null, approvedById: null, checkedAt: null, linkedAt: null },
  });
  await prisma.slackUserLink.updateMany({
    where: { orgId, status: "UNLINKED" },
    data: { slackTeamId: null, slackUserId: null, approvedById: null },
  });
}

/**
 * Disconnect: ask Slack to revoke the token, then delete it, the install,
 * every waiting message and every match, whether or not Slack answered (a
 * token Slack already dropped can't be revoked twice). Returns whether Slack
 * confirmed the revoke, and its error code when it didn't.
 */
export async function disconnectSlack(orgId: string, deps?: SlackDeps): Promise<{ had: boolean; revoked: boolean; revokeError: string | null }> {
  const bundle = await getOrgCredential(orgId, SLACK_NOTIFY).catch(() => null);
  const install = await prisma.slackInstallation.findUnique({ where: { orgId }, select: { id: true } });
  let revoked = false;
  let revokeError: string | null = null;
  if (bundle?.botToken) {
    try {
      await slackApi("auth.revoke", { bearer: bundle.botToken }, {}, deps);
      revoked = true;
    } catch (e) {
      revokeError = e instanceof SlackApiError ? e.code : "unknown_error";
      console.warn(`[slack] revoke on disconnect failed for org ${orgId}: ${revokeError}`);
    }
  }
  await deleteOrgCredential(orgId, SLACK_NOTIFY);
  await prisma.slackOutbox.deleteMany({ where: { orgId } });
  await prisma.slackInstallation.deleteMany({ where: { orgId } });
  await forgetMatches(orgId);
  return { had: !!(bundle || install), revoked, revokeError };
}

/** A message went out: the health readout's "last delivered". */
export async function recordSlackDelivery(orgId: string, at: Date) {
  await prisma.slackInstallation.updateMany({ where: { orgId }, data: { lastDeliveredAt: at } });
}

/**
 * Slack refused something. Kept on the install for the admin to see (the
 * code only), and in the log. A dead token also stops further sends until an
 * admin reconnects.
 */
export async function recordSlackFailure(orgId: string, err: SlackApiError, at: Date) {
  await prisma.slackInstallation.updateMany({
    where: { orgId },
    data: { lastErrorAt: at, lastErrorCode: err.code, ...(err.tokenDead ? { status: "ERROR" } : {}) },
  });
  console.warn(`[slack] org ${orgId}: ${err.code}${err.tokenDead ? " (token no longer works; reconnect Slack)" : ""}`);
}
