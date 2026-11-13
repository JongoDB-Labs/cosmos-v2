/**
 * The API handlers a caller with no session may reach, and why. One list,
 * read by both sides that used to keep their own:
 *
 *   - the proxy (src/proxy.ts) lets exactly these through without a session,
 *     and answers 401 for every other API request that has none;
 *   - the route sweep (src/app/api/__tests__/every-route-authenticates*.db.test.ts)
 *     checks every handler NOT in PUBLIC_HANDLERS refuses a caller it hasn't
 *     identified, and that the proxy passes these and nothing else.
 *
 * Two separate lists of the same thing drifted: a handler listed as public was
 * still refused by the proxy, so the sign-in page's account requests never
 * reached the route. Now a handler is public by being named here, once.
 *
 * Only the session check is skipped. The proxy still refuses a cross-origin
 * POST, PUT, PATCH or DELETE (CSRF) to these, as to any API path.
 *
 * Keys are `"<METHOD> <route path under src/app/api>"`, with the route's own
 * folder names: `[param]` for a dynamic segment, and a plugin's `(plugin-<slug>)`
 * route group, which the URL leaves out. Each value says who calls the handler
 * without a session and what its credential is, if any. A handler that takes a
 * credential of its own (a token in the path, a signed request) needs a test
 * that a WRONG one is refused, next to the ones in
 * every-route-authenticates.db.test.ts.
 */

/** Handlers that answer a caller with no credentials at all. The sweep doesn't check these refuse. */
export const PUBLIC_HANDLERS: Readonly<Record<string, string>> = {
  "GET health": "Liveness probe for the container and the load balancer.",
  "POST theme": "Sets this browser's light or dark cookie; reads and writes nothing else.",
  "GET orgs/[orgSlug]/brand":
    "The org's branding on its sign-in page: name, tagline, assistant name, colour scheme, and a logo only when it is hosted outside Cosmos.",
  "POST v1/metrics/errors": "Browser error telemetry, from signed-out pages too.",
  "POST v1/metrics/vitals": "Browser performance telemetry, from signed-out pages too.",

  // Signing in and out: how a user gets a session.
  "POST auth/account-request":
    "The sign-in page's request-an-account form. Answers the same whether or not the org or address exists; rate-limited per address and per client.",
  "GET auth/google": "Starts Google sign-in.",
  "GET auth/google/callback": "Google sign-in returns here; the OAuth state and code are the credential.",
  "GET auth/microsoft": "Starts Microsoft sign-in.",
  "GET auth/microsoft/callback": "Microsoft sign-in returns here; the OAuth state and code are the credential.",
  "GET auth/microsoft/status": "Whether the sign-in page shows the Microsoft button.",
  "GET auth/sso/[orgSlug]/login": "Starts an org's single sign-on.",
  "GET auth/sso/[orgSlug]/callback": "Single sign-on returns here; the OIDC state and code are the credential.",
  "GET auth/sso/[orgSlug]/status": "Whether the sign-in page offers or enforces an org's single sign-on.",
  "POST auth/password/login": "Password sign-in.",
  "POST auth/password/reset/request": "Asks for a reset email; answers the same whether or not the address exists.",
  "POST auth/password/reset/confirm": "Sets a new password; the emailed reset token is the credential.",
  "GET auth/logout": "Signing out works with or without a live session.",
  "POST auth/logout": "Signing out works with or without a live session.",

  // A credential other than a session. Each has a wrong-credential test.
  "GET v1/calendar/feeds/[token]": "Calendar apps fetch it with no session; the token in the path is the credential.",
  "GET v1/unsubscribe/filter/[token]": "Unsubscribe link opened from an email; the signed token in the path is the credential.",
  "POST v1/unsubscribe/filter/[token]": "Unsubscribe link opened from an email; the signed token in the path is the credential.",
  "POST teams/bot": "The Bot Framework calls it; its signed token is the credential.",
  "POST teams/tab/session": "A Teams tab signs in; the Teams sign-in token in the body is the credential.",
  "POST testenv/sign-in": "End-to-end tests only: off unless E2E_TEST_AUTH=1, and 404 in production regardless.",
  "GET testenv/user-id": "End-to-end tests only: off unless E2E_TEST_AUTH=1, and 404 in production regardless.",
};

/**
 * Steps of signing in that the proxy lets a caller with no session reach but
 * that are not public: each refuses a caller without its own credential (a
 * sign-in challenge, a first-login token), and the sweep checks that it does.
 */
export const SIGNED_OUT_STEPS: Readonly<Record<string, string>> = {
  "POST auth/password/mfa": "The sign-in code after a correct password; its credential is the sealed pending-MFA cookie.",
  "POST auth/password/first-login/change": "Sets a new password on first sign-in; its credential is the first-login cookie.",
  "POST auth/password/first-login/mfa-setup": "Starts authenticator setup on first sign-in; its credential is the first-login cookie.",
  "POST auth/password/first-login/mfa-enroll": "Finishes authenticator setup on first sign-in; its credential is the first-login cookie.",
};

/**
 * The same, for handlers composed in from a plugin. The proxy is core, so it
 * lists them here; in a build without the plugin the path has no route and
 * answers 404. The sweep still checks each refuses an unidentified caller (or
 * lists it in PLUGIN_KNOWN_OPEN, with why it doesn't yet).
 */
export const PLUGIN_SIGNED_OUT: Readonly<Record<string, string>> = {
  "POST (plugin-foreman)/foreman/alert":
    "A host watchdog posts its down-alert while the app's sessions may be gone; the route enforces its own bearer token.",
};

/** The URL pattern of a route path: `[x]` is one segment, `[...x]` one or more, `[[...x]]` none or more; route groups vanish. */
export function routePattern(rel: string): RegExp {
  const body = rel
    .split("/")
    .filter((seg) => seg && !/^\(.*\)$/.test(seg))
    .map((seg) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return "(?:/.*)?";
      if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return "/.+";
      if (/^\[[^\]]+\]$/.test(seg)) return "/[^/]+";
      return `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    })
    .join("");
  return new RegExp(`^/api${body}$`);
}

const ENTRIES = Object.keys({ ...PUBLIC_HANDLERS, ...SIGNED_OUT_STEPS, ...PLUGIN_SIGNED_OUT }).map((key) => {
  const [method, rel] = key.split(" ");
  return { method, path: routePattern(rel) };
});

/**
 * Whether a request with no session may reach the handler at this method and
 * path. HEAD counts as the GET that answers it; OPTIONS (which only reports
 * the allowed methods) counts for any listed path.
 */
export function signedOutMayReach(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return ENTRIES.some(
    (e) => (e.method === m || (m === "HEAD" && e.method === "GET") || m === "OPTIONS") && e.path.test(pathname),
  );
}
