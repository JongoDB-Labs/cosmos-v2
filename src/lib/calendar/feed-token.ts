import { createHash, randomBytes } from "node:crypto";

/**
 * COSMOS-202: the secret in a calendar feed link. 32 random bytes, base64url,
 * so 43 URL-safe characters that sit in the PATH (query strings end up in more
 * logs). Only the SHA-256 is stored, under a unique index: a lookup is an exact
 * index hit, so there is no secret comparison to time.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashFeedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newFeedToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashFeedToken(token) };
}

/** The token from a `<token>.ics` path segment, or null if it isn't one. */
export function parseFeedSegment(segment: string): string | null {
  const token = segment.endsWith(".ics") ? segment.slice(0, -4) : segment;
  return TOKEN_RE.test(token) ? token : null;
}

export function feedPath(token: string): string {
  return `/api/v1/calendar/feeds/${token}.ics`;
}
