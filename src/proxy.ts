import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { applySecurityHeaders, applyTeamsTabFraming, routeSetsOwnCsp } from "@/lib/security/headers";
import { isTabPath } from "@/lib/integrations/microsoft/teams-app/tab-paths";
import { classifyBearer, parseKeyToken } from "@/lib/auth/bearer";
import { signedOutMayReach } from "@/lib/auth/signed-out-api";
import { REQUEST_ID_HEADER, requestIdFor } from "@/lib/openapi/request-id";
import { problem } from "@/lib/openapi/problem";
import { isMutatingMethod, isPathOrgFrozen } from "@/lib/cutover/freeze";
import { otherAddressRedirect } from "@/lib/deploy/other-address-redirect";
import { legacyChatRedirect } from "@/lib/chat/legacy-chat-redirect";

function withSecurityHeaders(res: NextResponse): NextResponse {
  applySecurityHeaders(res.headers);
  return res;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Same-origin enforcement for mutating verbs. We accept either a matching
 * Origin or Referer header (some clients omit Origin). Same-site cookies
 * already constrain the worst of CSRF; this closes the residual gap where
 * a cross-origin form can POST against a logged-in user.
 *
 * Webhook ingestion routes (signed elsewhere) are exempt to keep
 * integrations working — extend this list carefully.
 */
const CSRF_EXEMPT_PREFIXES = [
  // External IdP redirect lands here without an Origin header.
  "/api/auth/google/callback",
  // Foreman watchdog down-alert: a host-side systemd curl with a dedicated
  // bearer (FOREMAN_ALERT_TOKEN) — an explicit, non-ambient credential the
  // route itself enforces (503 unset / 401 mismatch), so it cannot be
  // CSRF-forged by a browser. Same rationale as the `cosmos_` bearer skip.
  "/api/foreman/alert",
  // Cosmos for Teams bot (COSMOS-202 T1): the Bot Connector POSTs with its own
  // signed bearer JWT, which the route verifies; no browser, no cookie.
  "/api/teams/bot",
];
// NOTE: "/api/v1/orgs/" was previously exempted wholesale ("sub-routes do their
// own auth") — but auth is not CSRF defense, and that silently disabled the
// Origin check for every mutating verb on the entire org API (delete org,
// rename slug, members, invitations, projects, work items, …). There are no
// cross-origin callback/redirect targets under that tree, so it is enforced
// like any other API surface now.

function isCsrfExempt(pathname: string): boolean {
  // The path itself or below it, never a longer name that shares its prefix
  // ("/api/teams/botX" is not "/api/teams/bot"). Same rule as isPublic.
  return CSRF_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isSameOrigin(request: NextRequest): boolean {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const candidate = origin ?? referer;
  if (!candidate) return false;
  try {
    const u = new URL(candidate);
    if (u.host === host) return true;
    // Proxies commonly forward X-Forwarded-Host WITHOUT a port (e.g. Caddy's
    // {host} placeholder strips it), while a browser Origin on a nonstandard
    // port includes one — so every mutating request 403'd on such deploys.
    // Accept a hostname match when the forwarded host carries no port.
    return !host.includes(":") && u.hostname === host;
  } catch {
    return false;
  }
}

// Pages a visitor with no session may open. Which API handlers a caller with
// no session reaches is not decided here: it is the one list in
// lib/auth/signed-out-api.ts, which the route sweep tests read as well, so the
// two can't disagree about what is public.
const PUBLIC_PAGE_PREFIXES = [
  "/login",
  // Teams tabs (T1 d): framed by Teams with no Cosmos session; the pages do
  // their own auth (the tab session).
  "/teams/tab",
  "/manifest.webmanifest",
];

// Static asset extensions served from /public — bypass auth so Next.js's
// image optimizer (which does internal HTTP fetches) and unauth'd pages
// like /login can load their images. Never under /api: there a final segment
// is often an id, and `…/documents/x.png` is a route, not a file.
const STATIC_ASSET_EXT = /\.(?:png|svg|ico|jpe?g|webp|gif|woff2?|ttf|otf|js)$/i;

function isPublic(method: string, pathname: string): boolean {
  if (pathname.startsWith("/api/")) return signedOutMayReach(method, pathname);
  if (STATIC_ASSET_EXT.test(pathname)) return true;
  return PUBLIC_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  // X-Request-Id on every response, and on the request the route sees (see
  // lib/openapi/request-id.ts). Set here, outside `gate`, so no early return
  // in it can skip the header.
  const requestId = requestIdFor(request.headers.get(REQUEST_ID_HEADER));
  const next = () => {
    const forwarded = new Headers(request.headers);
    forwarded.set(REQUEST_ID_HEADER, requestId);
    return NextResponse.next({ request: { headers: forwarded } });
  };
  const res = await gate(request, next);
  res.headers.set(REQUEST_ID_HEADER, requestId);
  // Teams tabs (COSMOS-202 T1 d) are the only pages another site may frame,
  // and only Microsoft Teams' hosts. Everything else keeps 'none'.
  if (isTabPath(request.nextUrl.pathname)) applyTeamsTabFraming(res.headers);
  // Stored files carry the CSP their route chose; the page CSP set above would
  // replace it (see routeSetsOwnCsp).
  if (routeSetsOwnCsp(request.nextUrl.pathname)) res.headers.delete("Content-Security-Policy");
  return res;
}

async function gate(request: NextRequest, next: () => NextResponse): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // A page visit at one of the instance's other addresses goes to the one
  // people should use (COSMOS_PUBLIC_URL), when that is set. First, so a
  // signed-out visitor signs in at the new address rather than the old.
  const elsewhere = otherAddressRedirect({
    method: request.method,
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    pathname,
    search: request.nextUrl.search,
  });
  // Not when the target shares Next's internal host: Next rewrites such a
  // redirect to a relative one (next/dist/server/web/adapter.js), which sends
  // the visitor back to the address they came from, forever. Found by driving
  // it locally; prod's internal host is never its public one.
  if (elsewhere && new URL(elsewhere).host !== request.nextUrl.host) {
    return withSecurityHeaders(NextResponse.redirect(elsewhere, 307));
  }

  // Teams tabs (COSMOS-202 T1 d) are read-only pages, and their session is
  // honoured only for a GET: anything else never reaches them.
  if (isTabPath(pathname) && request.method !== "GET" && request.method !== "HEAD") {
    return withSecurityHeaders(new NextResponse(null, { status: 405, headers: { Allow: "GET, HEAD" } }));
  }

  // CSRF: refuse cross-origin mutating verbs. The session cookie is
  // SameSite=Lax so the common case is already covered; this catches
  // edge cases (e.g. attacker-controlled subdomain) explicitly.
  //
  // Cosmos bearer API-key requests are exempt: a `cosmos_` token is an
  // explicit, non-ambient credential (the caller sets the Authorization header
  // deliberately — it isn't attached by the browser like a cookie), so it
  // can't be CSRF-forged by a cross-origin page. We only skip the Origin check
  // for a header shaped like an API key (`parseKeyToken` in lib/auth/bearer.ts);
  // any other `Bearer …` is no credential and falls back to cookie auth, so it
  // must stay guarded. Cookie (no-Authorization) requests are still fully
  // guarded too.
  const authorization = request.headers.get("authorization");
  const keyBearer = parseKeyToken(authorization) !== null;
  if (
    MUTATING_METHODS.has(request.method) &&
    pathname.startsWith("/api/") &&
    !isCsrfExempt(pathname) &&
    !keyBearer &&
    !isSameOrigin(request)
  ) {
    return withSecurityHeaders(
      new NextResponse(JSON.stringify({ error: "csrf_blocked" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  // Cutover write-FREEZE (design spec §9.4): while an org is mid-migration, a row in
  // `frozen_orgs` blocks its MUTATING verbs with 405 (reads keep working). Checked only
  // for mutating methods (the rare path), and only when the URL targets an org — so the
  // overwhelming GET traffic never pays for it. Runs before auth so a frozen org is frozen
  // for everyone, authenticated or not.
  if (isMutatingMethod(request.method) && (await isPathOrgFrozen(pathname))) {
    return withSecurityHeaders(
      new NextResponse(
        JSON.stringify({ error: "org_frozen", detail: "This organization is in a migration write-freeze. Try again shortly." }),
        { status: 405, headers: { "Content-Type": "application/json", Allow: "GET, HEAD, OPTIONS" } },
      ),
    );
  }

  if (isPublic(request.method, pathname)) {
    return withSecurityHeaders(next());
  }

  // The full-page chat is gone; chat opens in the drawer. Its old addresses
  // (bookmarks, emailed links, notifications already sent) go back to the page
  // the person came from, or the org home, with the drawer open on the same
  // conversation. Before the session check, so it costs no database read; a
  // signed-out visitor is then sent to sign in from the new address.
  const toDrawer = legacyChatRedirect({
    method: request.method,
    pathname,
    referer: request.headers.get("referer"),
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  });
  if (toDrawer) {
    return withSecurityHeaders(NextResponse.redirect(new URL(toDrawer, request.url), 307));
  }

  // A `cosmos_` bearer that isn't shaped like an API key is no credential:
  // nothing issues the OAuth shapes yet, and a malformed one never verifies.
  // Refuse it here, whatever cookie comes with it, rather than leave every
  // route to. (When OAuth tokens are issued, let `oauth_access` through here.)
  if (pathname.startsWith("/api/") && classifyBearer(authorization) !== null && !keyBearer) {
    return withSecurityHeaders(problem(401, "unauthorized"));
  }

  const sessionId = request.cookies.get(SESSION_COOKIE)?.value;

  if (sessionId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { expiresAt: true },
    });

    if (session && session.expiresAt.getTime() > Date.now()) {
      return withSecurityHeaders(next());
    }
  }

  // API-key (bearer) requests carry no session cookie — they authenticate at the
  // route via resolveAuth()/verifyApiKey(). Let a key-shaped bearer through the
  // session gate so the route can enforce the key; a bad/expired key is rejected
  // there (401). Only /api routes, and only the key shape — a non-cosmos
  // `Bearer …` is NOT a session and stays blocked here.
  if (pathname.startsWith("/api/") && keyBearer) {
    return withSecurityHeaders(next());
  }

  // Unauthenticated. JSON 401 for API, redirect to /login otherwise.
  if (pathname.startsWith("/api/")) {
    return withSecurityHeaders(problem(401, "unauthorized"));
  }

  const loginUrl = new URL("/login", request.url);
  return withSecurityHeaders(NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|public/).*)",
  ],
};
