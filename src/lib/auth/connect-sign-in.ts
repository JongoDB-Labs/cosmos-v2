import crypto from "node:crypto";

/**
 * Connecting a sign-in method (Profile, Sign-in methods) rides the provider's
 * normal OAuth round trip, with one extra cookie set when it starts: which
 * provider, the OAuth `state`, where to come back to, and a hash of the session
 * that asked. The callback acts on it only when the provider and `state` match,
 * and only for that same session, so a link can't land on whoever happens to be
 * signed in when the callback returns, and a stale cookie never turns a later
 * sign-in into a link.
 */
export const CONNECT_COOKIE = "signin_connect";
export const CONNECT_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export type ConnectProvider = "google" | "microsoft";

type Payload = { p: ConnectProvider; s: string; h: string; r: string };

export function sessionHash(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("base64url");
}

/** A same-site path to come back to; anything else becomes "/". URL parsing
 *  drops tabs and newlines, so "/\t/evil.example" would become "//evil.example":
 *  whitespace and control characters are refused outright. */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 512 || !/^\/(?![/\\])[^\s\\\x00-\x1f\x7f]*$/.test(raw)) {
    return "/";
  }
  return raw;
}

export function connectCookieValue(input: {
  provider: ConnectProvider;
  state: string;
  sessionId: string;
  returnTo: string;
}): string {
  const payload: Payload = {
    p: input.provider,
    s: input.state,
    h: sessionHash(input.sessionId),
    r: safeReturnTo(input.returnTo),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** The connect request this callback answers, or null when it is a sign-in. */
export function readConnectIntent(
  cookie: string | undefined,
  provider: ConnectProvider,
  state: string,
): { sessionHash: string; returnTo: string } | null {
  if (!cookie) return null;
  let p: Partial<Payload>;
  try {
    p = JSON.parse(Buffer.from(cookie, "base64url").toString("utf8")) as Partial<Payload>;
  } catch {
    return null;
  }
  if (p.p !== provider || typeof p.s !== "string" || p.s !== state || typeof p.h !== "string") return null;
  return { sessionHash: p.h, returnTo: safeReturnTo(p.r) };
}

/** `returnTo` with the outcome for the Sign-in methods section to show. */
export function connectOutcomeUrl(
  origin: string,
  returnTo: string,
  outcome: { connected: ConnectProvider } | { error: string },
): URL {
  let url = new URL(safeReturnTo(returnTo), origin);
  if (url.origin !== new URL(origin).origin) url = new URL("/", origin);
  if ("connected" in outcome) url.searchParams.set("connected", outcome.connected);
  else url.searchParams.set("connect_error", outcome.error);
  return url;
}
