import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { applySecurityHeaders, applyTeamsTabFraming } from "@/lib/security/headers";
import { isTabPath } from "@/lib/integrations/microsoft/teams-app/tab-paths";
import { classifyBearer } from "@/lib/auth/bearer";
import { REQUEST_ID_HEADER, requestIdFor } from "@/lib/openapi/request-id";
import { problem } from "@/lib/openapi/problem";
import { budgetHeaders, chargeApiBudget } from "@/lib/rate-limit/api-budget";
import { isMutatingMethod, isPathOrgFrozen } from "@/lib/cutover/freeze";

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

// Paths that should bypass the session check entirely.
const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/api/auth/google",
  "/api/auth/google/callback",
  // Microsoft (Entra ID) sign-in: initiate + callback + the config probe are
  // all pre-auth (they're how a user GETS a session).
  "/api/auth/microsoft",
  // SSO (OIDC RP) — login initiation, IdP callback, and the pre-auth SSO-status
  // probe are all unauthenticated by definition (they're how a user GETS a
  // session). Covers /api/auth/sso/<orgSlug>/{login,callback,status}.
  "/api/auth/sso",
  // Local email/password sign-in + the TOTP challenge are how a user GETS a
  // session, so they're unauthenticated by definition. Covers
  // /api/auth/password/{login,mfa}. (CSRF is still enforced — these are
  // same-origin POSTs from /login — only the session check is bypassed.)
  "/api/auth/password",
  "/api/auth/logout",
  "/api/health",
  "/api/theme",
  "/api/v1/metrics", // client telemetry sinks (errors, vitals)
  // Calendar subscription feeds (COSMOS-202): fetched by Outlook / Google /
  // Apple Calendar servers, which have no session. The path token is the
  // credential; the route checks it, the org switch and the person's access.
  "/api/v1/calendar/feeds",
  // Filter-email unsubscribe links (query design §11.2): opened from a mail
  // client, often signed out. The path token, MAC'd per subscription, is the
  // credential; GET only shows a confirmation, and the same-origin form POST
  // it sends is what unsubscribes.
  "/api/v1/unsubscribe/filter",
  // Watchdog down-alert — no browser session by definition (the daemon is
  // down); the route enforces its own bearer token.
  "/api/foreman/alert",
  // Cosmos for Teams bot (COSMOS-202 T1): the Bot Connector has no session;
  // the route verifies its signed token before anything else.
  "/api/teams/bot",
  // Teams tabs (T1 d): framed by Teams with no Cosmos session; the pages and
  // the sign-in route do their own auth (the tab session).
  "/api/teams/tab/session",
  "/teams/tab",
  "/manifest.webmanifest",
  // Test-only routes — only active when E2E_TEST_AUTH=1; session check is
  // moot because these routes create/look up sessions themselves.
  "/api/testenv",
];

// Static asset extensions served from /public — bypass auth so Next.js's
// image optimizer (which does internal HTTP fetches) and unauth'd pages
// like /login can load their images.
const STATIC_ASSET_EXT = /\.(?:png|svg|ico|jpe?g|webp|gif|woff2?|ttf|otf|js)$/i;

function isPublic(pathname: string): boolean {
  if (STATIC_ASSET_EXT.test(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some(
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
  // Per-token budget (lib/rate-limit/api-budget.ts): every request presenting
  // a Cosmos bearer is charged here, before any route runs, and every answer
  // to one says what is left.
  const authorization = request.headers.get("authorization");
  const budget =
    request.nextUrl.pathname.startsWith("/api/") && authorization && classifyBearer(authorization) !== null
      ? chargeApiBudget(authorization, request.method)
      : null;
  const res = budget && !budget.allowed
    ? withSecurityHeaders(problem(429, "rate_limited", "Rate limit exceeded for this token"))
    : await gate(request, next);
  if (budget) for (const [k, v] of Object.entries(budgetHeaders(budget))) res.headers.set(k, v);
  res.headers.set(REQUEST_ID_HEADER, requestId);
  // Teams tabs (COSMOS-202 T1 d) are the only pages another site may frame,
  // and only Microsoft Teams' hosts. Everything else keeps 'none'.
  if (isTabPath(request.nextUrl.pathname)) applyTeamsTabFraming(res.headers);
  return res;
}

async function gate(request: NextRequest, next: () => NextResponse): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

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
  // for a `cosmos_` bearer (`classifyBearer` in lib/auth/bearer.ts); a
  // non-cosmos `Bearer …` falls back to cookie auth, so it must stay guarded.
  // Cookie (no-Authorization) requests are still fully guarded too.
  if (
    MUTATING_METHODS.has(request.method) &&
    pathname.startsWith("/api/") &&
    !isCsrfExempt(pathname) &&
    classifyBearer(request.headers.get("authorization")) === null &&
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

  if (isPublic(pathname)) {
    return withSecurityHeaders(next());
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
  // route via resolveAuth()/verifyApiKey(). Let a `cosmos_` bearer through the
  // session gate so the route can enforce the key; a bad/expired key is rejected
  // there (401). Only /api routes, and only the cosmos token shape — a non-cosmos
  // `Bearer …` is NOT a session and stays blocked here.
  if (
    pathname.startsWith("/api/") &&
    classifyBearer(request.headers.get("authorization")) !== null
  ) {
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
