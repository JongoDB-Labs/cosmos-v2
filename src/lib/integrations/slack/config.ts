/**
 * Slack notifications: the constants and the instance configuration.
 *
 * The Slack app is the instance's, one per Cosmos install, created by its
 * operator (docs/runbooks/slack-notifications.md). Its credentials come from
 * the environment, like the other instance-wide app credentials (Google
 * sign-in's GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET fallback, Nango's
 * NANGO_SECRET_KEY): server-only, never NEXT_PUBLIC_, never in the database.
 * Each org then installs that app into its own Slack workspace ("Add to
 * Slack"), and that install's bot token is sealed per org.
 *
 *   SLACK_CLIENT_ID      the app's Client ID (Basic Information).
 *   SLACK_CLIENT_SECRET  the app's Client Secret.
 *   SLACK_API_ORIGIN     optional; where Slack lives (default https://slack.com).
 *                        For tests and local runs against a stand-in only.
 *
 * No signing secret: Cosmos only calls Slack. It takes no requests from Slack
 * (no events, commands or buttons), so there is nothing to verify.
 */

/** Connector-credential provider for the org's sealed bot token. */
export const SLACK_NOTIFY = "slack-notifications";

/**
 * The bot scopes asked for, and no more: write a message (chat:write), open
 * the direct message it goes in (im:write), and find a member by their email
 * (users:read, users:read.email).
 */
export const SLACK_SCOPES = ["chat:write", "im:write", "users:read", "users:read.email"] as const;

/** Fixed path, registered once as the Slack app's redirect URL. */
export const SLACK_CALLBACK_PATH = "/api/v1/slack/oauth/callback";
export const SLACK_STATE_COOKIE = "slack_oauth_state";

/** The notifications a person can have sent to Slack. */
export const SLACK_NOTIFY_TYPES = ["assigned", "mentioned"] as const;
export type SlackNotifyType = (typeof SLACK_NOTIFY_TYPES)[number];

/** Cosmos notification type -> the Slack choice that covers it. */
export const SLACK_TYPE_OF_NOTIFICATION: Readonly<Record<string, SlackNotifyType>> = {
  "work_item.assigned": "assigned",
  "comment.mentioned": "mentioned",
};

/** A member Slack had no (confirmed) account for is looked up again after this long. */
export const SLACK_RECHECK_MS = 24 * 60 * 60_000;

export const isSlackNotifyType = (v: unknown): v is SlackNotifyType =>
  typeof v === "string" && (SLACK_NOTIFY_TYPES as readonly string[]).includes(v);

export interface SlackAppConfig {
  clientId: string;
  clientSecret: string;
}

/** The instance's Slack app, or null until both values are set. */
export function slackAppConfig(env: Record<string, string | undefined> = process.env): SlackAppConfig | null {
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Slack's origin. https only, except a loopback stand-in (http://localhost:…),
 * so a misconfiguration can't send a bot token over plain HTTP to anywhere else.
 */
export function slackOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SLACK_API_ORIGIN?.trim();
  if (!raw) return "https://slack.com";
  try {
    const u = new URL(raw);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.origin;
  } catch {
    /* fall through */
  }
  return "https://slack.com";
}
