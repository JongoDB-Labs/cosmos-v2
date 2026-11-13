import { createHash, randomBytes } from "node:crypto";
import { openSecret, sealSecret } from "@/lib/crypto/vault";
import { SLACK_SCOPES, slackOrigin, type SlackAppConfig } from "./config";
import { SlackApiError, slackApi, type SlackDeps } from "./web-api.server";

/**
 * "Add to Slack": Slack's OAuth v2 install, started by an org admin.
 *
 * The `state` is random and travels to Slack and back in the URL; a SEALED
 * cookie (authenticated encryption under the vault key, so it can't be forged
 * or edited) carries the same value plus who started it, for which org, from
 * which address, and until when. The callback accepts only a state that
 * matches its cookie, is unexpired, belongs to the person signed in now, and
 * hasn't been used: that is the CSRF check, and it binds the install to the
 * admin and org that began it.
 */

const STATE_TTL_MS = 10 * 60_000;

export interface InstallState {
  state: string;
  orgId: string;
  userId: string;
  /** The public origin the install started from; the redirect URI is built on it. */
  origin: string;
  exp: number;
}

export function newInstallState(orgId: string, userId: string, origin: string, now = Date.now()) {
  const s: InstallState = { state: randomBytes(24).toString("base64url"), orgId, userId, origin, exp: now + STATE_TTL_MS };
  return { cookie: sealSecret(JSON.stringify(s)), state: s.state };
}

/**
 * States already used, by hash, until they would have expired anyway, so a
 * replayed callback is refused even if the browser kept the cookie. Per
 * process; the 10-minute expiry bounds it, and Slack's code is single-use.
 */
const usedStates = new Map<string, number>();
const MAX_USED_STATES = 10_000;

/** Test hook. */
export function _resetUsedInstallStates() {
  usedStates.clear();
}

/** The sealed cookie, if it is intact, unexpired, unused and matches `state`. */
export function openInstallState(cookie: string | undefined, state: string | null, now = Date.now()): InstallState | null {
  if (!cookie || !state) return null;
  let s: InstallState;
  try {
    s = JSON.parse(openSecret(cookie)) as InstallState;
  } catch {
    return null;
  }
  if (typeof s.state !== "string" || s.state !== state || typeof s.exp !== "number" || s.exp < now) return null;
  if (typeof s.orgId !== "string" || typeof s.userId !== "string" || typeof s.origin !== "string") return null;
  for (const [h, exp] of usedStates) if (exp < now) usedStates.delete(h);
  const h = createHash("sha256").update(state).digest("base64url");
  if (usedStates.has(h)) return null;
  if (usedStates.size >= MAX_USED_STATES) usedStates.delete(usedStates.keys().next().value as string);
  usedStates.set(h, s.exp);
  return s;
}

export function slackAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    scope: SLACK_SCOPES.join(","),
    redirect_uri: o.redirectUri,
    state: o.state,
  });
  return `${slackOrigin()}/oauth/v2/authorize?${q}`;
}

export interface SlackGrant {
  botToken: string;
  teamId: string;
  teamName: string;
  botUserId: string | null;
  appId: string | null;
  scopes: string[];
}

/** An install Cosmos won't take, and why (a code the settings page puts into words). */
export class SlackInstallRefused extends Error {
  constructor(
    public code: "enterprise_install" | "missing_scopes" | "extra_scopes" | "workspace_taken",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Trade the code for the bot token. Refused unless Slack returned a bot token
 * for one workspace with exactly the scopes asked for (SLACK_SCOPES, the app
 * manifest's in docs/runbooks/slack-notifications.md): an org-wide Enterprise
 * Grid install isn't supported, a grant missing a scope would fail later, at
 * the first message, where nobody is looking, and one with more would leave
 * Cosmos holding a token that can do more than it needs.
 */
export async function exchangeInstallCode(
  app: SlackAppConfig,
  o: { code: string; redirectUri: string },
  deps?: SlackDeps,
): Promise<SlackGrant> {
  const r = await slackApi<{
    access_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
    bot_user_id?: unknown;
    app_id?: unknown;
    team?: { id?: unknown; name?: unknown } | null;
    is_enterprise_install?: unknown;
  }>("oauth.v2.access", { basic: { user: app.clientId, password: app.clientSecret } }, { code: o.code, redirect_uri: o.redirectUri }, deps);
  if (r.is_enterprise_install === true) {
    throw new SlackInstallRefused("enterprise_install", "Install the app into a single workspace. Organization-wide Enterprise Grid installs aren't supported.");
  }
  if (r.token_type !== "bot" || typeof r.access_token !== "string" || !r.access_token.startsWith("xoxb-")) {
    throw new SlackApiError("bad_response", 200);
  }
  const teamId = r.team?.id;
  if (typeof teamId !== "string" || !teamId) throw new SlackApiError("bad_response", 200);
  const scopes = typeof r.scope === "string" ? r.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const missing = SLACK_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) {
    throw new SlackInstallRefused("missing_scopes", `Slack didn't grant ${missing.join(", ")}. Check the app's bot token scopes, then try again.`);
  }
  const extra = scopes.filter((s) => !(SLACK_SCOPES as readonly string[]).includes(s));
  if (extra.length) {
    throw new SlackInstallRefused(
      "extra_scopes",
      `The Slack app has bot token scopes Cosmos doesn't use: ${extra.join(", ")}. Remove them so the app has exactly ${SLACK_SCOPES.join(", ")}, then try again.`,
    );
  }
  return {
    botToken: r.access_token,
    teamId,
    teamName: typeof r.team?.name === "string" ? r.team.name : "",
    botUserId: typeof r.bot_user_id === "string" ? r.bot_user_id : null,
    appId: typeof r.app_id === "string" ? r.app_id : null,
    scopes,
  };
}
