import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { applySecurityHeaders } from "@/lib/security/headers";
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
];
// NOTE: "/api/v1/orgs/" was previously exempted wholesale ("sub-routes do their
// own auth") — but auth is not CSRF defense, and that silently disabled the
// Origin check for every mutating verb on the entire org API (delete org,
// rename slug, members, invitations, projects, work items, …). There are no
// cross-origin callback/redirect targets under that tree, so it is enforced
// like any other API surface now.

function isCsrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
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
    return u.host === host;
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
  const { pathname } = request.nextUrl;

  // CSRF: refuse cross-origin mutating verbs. The session cookie is
  // SameSite=Lax so the common case is already covered; this catches
  // edge cases (e.g. attacker-controlled subdomain) explicitly.
  //
  // Bearer API-key requests are exempt: a `Bearer` token is an explicit,
  // non-ambient credential (the caller sets the Authorization header
  // deliberately — it isn't attached by the browser like a cookie), so it
  // can't be CSRF-forged by a cross-origin page. We only skip the Origin
  // check when a bearer is present; cookie (no-Authorization) requests are
  // still fully guarded.
  if (
    MUTATING_METHODS.has(request.method) &&
    pathname.startsWith("/api/") &&
    !isCsrfExempt(pathname) &&
    !request.headers.get("authorization")?.startsWith("Bearer ") &&
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
    return withSecurityHeaders(NextResponse.next());
  }

  const sessionId = request.cookies.get(SESSION_COOKIE)?.value;

  if (sessionId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { expiresAt: true },
    });

    if (session && session.expiresAt.getTime() > Date.now()) {
      return withSecurityHeaders(NextResponse.next());
    }
  }

  // Unauthenticated. JSON 401 for API, redirect to /login otherwise.
  if (pathname.startsWith("/api/")) {
    return withSecurityHeaders(
      new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  const loginUrl = new URL("/login", request.url);
  return withSecurityHeaders(NextResponse.redirect(loginUrl));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|public/).*)",
  ],
};
