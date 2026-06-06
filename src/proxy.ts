import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { applySecurityHeaders } from "@/lib/security/headers";

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
  "/api/auth/google/callback",
  "/api/v1/orgs/", // sub-routes do their own auth; some legitimate redirects skip Origin
];

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
  // SSO (OIDC RP) — login initiation, IdP callback, and the pre-auth SSO-status
  // probe are all unauthenticated by definition (they're how a user GETS a
  // session). Covers /api/auth/sso/<orgSlug>/{login,callback,status}.
  "/api/auth/sso",
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
  if (
    MUTATING_METHODS.has(request.method) &&
    pathname.startsWith("/api/") &&
    !isCsrfExempt(pathname) &&
    !isSameOrigin(request)
  ) {
    return withSecurityHeaders(
      new NextResponse(JSON.stringify({ error: "csrf_blocked" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
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
