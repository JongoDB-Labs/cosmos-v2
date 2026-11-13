import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { getSessionUser } from "@/lib/auth/session";
import { classifyBearer } from "@/lib/auth/bearer";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { connectSignInRefusal } from "@/lib/internal/access";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import {
  CONNECT_COOKIE,
  CONNECT_COOKIE_MAX_AGE_SECONDS,
  connectCookieValue,
  connectOutcomeUrl,
  readConnectIntent,
  safeReturnTo,
  sessionHash,
  type ConnectProvider,
} from "@/lib/auth/connect-sign-in";
import { connectFirstPartyIdentity, type FirstPartyIdentity } from "@/lib/auth/first-party-identity";

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge,
  secure: process.env.NODE_ENV === "production",
});

/**
 * The session cookie this request is judged by, as getCurrentUser judges it:
 * none at all when the request presents a Cosmos bearer (valid or not). The
 * proxy skips its same-origin check for a key-shaped bearer, so a cookie riding
 * along with one must not count as a signed-in session here either.
 */
function sessionCookieOf(request: NextRequest): string | null {
  if (classifyBearer(request.headers.get("authorization")) !== null) return null;
  return request.cookies.get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Start connecting `provider` to the signed-in account. A POST from the
 * Sign-in methods form: the session cookie is SameSite=lax, so another site
 * can't start this on someone's behalf. Redirects (303) to the provider with
 * the provider's own state cookie plus the connect cookie.
 */
export async function startConnect(
  request: NextRequest,
  provider: ConnectProvider,
  opts: { stateCookie: string; authorizeUrl: (state: string) => Promise<string> },
): Promise<NextResponse> {
  const origin = getPublicOrigin(request);
  const form = await request.formData().catch(() => null);
  const returnTo = safeReturnTo(form?.get("returnTo"));

  const sessionId = sessionCookieOf(request);
  const user = sessionId ? await getSessionUser(sessionId) : null;
  if (!sessionId || !user) return NextResponse.redirect(new URL("/login", origin), 303);
  const refusal = connectSignInRefusal(user);
  if (refusal) return NextResponse.redirect(connectOutcomeUrl(origin, returnTo, { error: refusal }), 303);

  const rl = rateLimit(getRateLimitKey(request, "auth.start"), { capacity: 15, refillPerSecond: 1 });
  if (!rl.allowed) {
    return NextResponse.redirect(connectOutcomeUrl(origin, returnTo, { error: "rate_limited" }), 303);
  }

  const state = crypto.randomBytes(16).toString("hex");
  let authUrl: string;
  try {
    authUrl = await opts.authorizeUrl(state);
  } catch {
    return NextResponse.redirect(connectOutcomeUrl(origin, returnTo, { error: "not_configured" }), 303);
  }
  const res = NextResponse.redirect(authUrl, 303);
  res.cookies.set(opts.stateCookie, state, cookieOptions(5 * 60));
  res.cookies.set(
    CONNECT_COOKIE,
    connectCookieValue({ provider, state, sessionId, returnTo }),
    cookieOptions(CONNECT_COOKIE_MAX_AGE_SECONDS),
  );
  return res;
}

/** The connect request this callback answers, or null for an ordinary sign-in. */
export function connectIntent(request: NextRequest, provider: ConnectProvider, state: string) {
  return readConnectIntent(request.cookies.get(CONNECT_COOKIE)?.value, provider, state);
}

/**
 * Finish a connect: the session that asked must still be the one signed in, and
 * still allowed to connect; then the identity is bound to that account. Mints no
 * session. Returns to the Sign-in methods page with the outcome.
 */
export async function finishConnect(
  request: NextRequest,
  intent: { sessionHash: string; returnTo: string },
  identity: FirstPartyIdentity,
  opts: { stateCookie: string; afterConnect?: (userId: string) => Promise<unknown> },
): Promise<NextResponse> {
  const origin = getPublicOrigin(request);
  const done = (outcome: { connected: ConnectProvider } | { error: string }) => {
    const res = NextResponse.redirect(connectOutcomeUrl(origin, intent.returnTo, outcome));
    res.cookies.delete(CONNECT_COOKIE);
    res.cookies.delete(opts.stateCookie);
    return res;
  };

  const sessionId = sessionCookieOf(request);
  if (!sessionId || sessionHash(sessionId) !== intent.sessionHash) return done({ error: "session_changed" });
  const user = await getSessionUser(sessionId);
  if (!user) return done({ error: "session_changed" });
  const refusal = connectSignInRefusal(user);
  if (refusal) return done({ error: refusal });

  const result = await connectFirstPartyIdentity(user.id, identity);
  if (!result.ok) {
    console.warn(`[auth:${identity.provider}] connect refused: ${result.reason}`);
    return done({ error: result.reason });
  }
  if (opts.afterConnect) {
    try {
      await opts.afterConnect(user.id);
    } catch (err) {
      console.warn(`[auth:${identity.provider}] after-connect step failed`, err instanceof Error ? err.message : err);
    }
  }
  return done({ connected: identity.provider });
}
