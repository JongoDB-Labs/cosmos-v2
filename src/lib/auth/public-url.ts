/**
 * Return the public origin (scheme + host) the request came in on, honoring
 * reverse-proxy headers. Next.js 16's `request.url` defaults to the internal
 * bind hostname (e.g. http://localhost:3000), which would emit broken Location
 * headers when the app is fronted by nginx/Cloudflare Tunnel.
 *
 * Order of trust:
 * 1. `x-forwarded-host` + `x-forwarded-proto` (from nginx/Cloudflare)
 * 2. `host` header + scheme inferred from host (https for non-localhost)
 * 3. Fall back to request.url's origin
 */
export function getPublicOrigin(request: Request): string {
  // Last-resort fallback — should be unreachable in practice
  return publicOriginFromHeaders(request.headers) ?? new URL(request.url).origin;
}

/**
 * Steps 1 and 2 of `getPublicOrigin`, for a server component, which has
 * `headers()` rather than a Request. Null when neither host header is present,
 * or when the one chosen is not a host, so the caller falls back.
 *
 * A proxy chain can forward several values, comma-separated; the first is the
 * one the client reached. Only a bare host (with an optional port) is used,
 * and only http or https as the scheme: anything else would make a broken
 * origin, and `new URL` on it throws.
 */
export function publicOriginFromHeaders(headers: Pick<Headers, "get">): string | null {
  const host = firstValue(headers.get("x-forwarded-host") ?? headers.get("host"));
  if (!host || !BARE_HOST.test(host)) return null;
  const forwardedProto = firstValue(headers.get("x-forwarded-proto"))?.toLowerCase();
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : host.startsWith("localhost") || host.startsWith("127.")
        ? "http"
        : "https";
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/** A host name or IPv4 address, or a bracketed IPv6 address, with an optional port: nothing else. */
const BARE_HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** The first of a header's comma-separated values, trimmed; null when there is none. */
function firstValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0].trim();
  return first ? first : null;
}
