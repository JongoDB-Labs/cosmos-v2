/**
 * Where Microsoft lives, as configuration (COSMOS-202 B). Commercial cloud by
 * default; the owner chose commercial only, but the hosts stay config so a
 * sovereign cloud would be a setting rather than a code change. Full origins
 * (scheme included), so a test or dev run can point them at a local stand-in.
 */
const strip = (s: string) => s.replace(/\/+$/, "");

export function microsoftLoginOrigin(): string {
  return strip(process.env.MICROSOFT_LOGIN_ORIGIN || "https://login.microsoftonline.com");
}

export function microsoftGraphOrigin(): string {
  return strip(process.env.MICROSOFT_GRAPH_ORIGIN || "https://graph.microsoft.com");
}

/** Where the Bot Framework publishes the keys it signs requests to bots with. */
export function botFrameworkLoginOrigin(): string {
  return strip(process.env.BOT_FRAMEWORK_LOGIN_ORIGIN || "https://login.botframework.com");
}
