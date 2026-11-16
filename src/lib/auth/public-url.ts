/**
 * Return the public origin (scheme + host) the request came in on, honoring
 * reverse-proxy headers. Next.js 16's `request.url` defaults to the internal
 * bind hostname (e.g. http://localhost:3000), which would emit broken Location
 * headers when the app is fronted by nginx/Cloudflare Tunnel.
 *
 * Order of trust:
 * 1. `x-forwarded-host` + `x-forwarded-proto` (from nginx/Cloudflare)
 * 2. `host` header + scheme inferred from host (https for non-localhost),
 *    also when the forwarded host is not a bare host
 * 3. Fall back to request.url's origin
 */
export function getPublicOrigin(request: Request): string {
  // Reached when neither header holds a usable host.
  return publicOriginFromHeaders(request.headers) ?? new URL(request.url).origin;
}

/**
 * Steps 1 and 2 of `getPublicOrigin`, for a server component, which has
 * `headers()` rather than a Request. Null when neither header holds a usable
 * host, so the caller falls back.
 *
 * A proxy that appends to a forwarded header puts its own value last; anything
 * to the left of it came from the client. So the right-most value is the one
 * used, and only if it is a bare host with an optional port: a value with a
 * scheme, path, credentials or spaces is refused, and the Host header is used
 * instead. The scheme is likewise the right-most forwarded value, and only
 * http or https; otherwise it is inferred.
 */
export function publicOriginFromHeaders(headers: Pick<Headers, "get">): string | null {
  const host = bareHost(headers.get("x-forwarded-host")) ?? bareHost(headers.get("host"));
  if (!host) return null;
  const forwardedProto = lastValue(headers.get("x-forwarded-proto"))?.toLowerCase();
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : host.startsWith("localhost") || host.startsWith("127.")
        ? "http"
        : "https";
  return new URL(`${proto}://${host}`).origin;
}

/**
 * A host name or IPv4 address (with at most one trailing dot, kept as given),
 * or a bracketed IPv6 address, with an optional port: nothing else.
 */
const BARE_HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** A header's right-most value, if it is a bare host that a URL can hold (a port over 65535 can't be); else null. */
function bareHost(value: string | null): string | null {
  const host = lastValue(value);
  if (!host || !BARE_HOST.test(host)) return null;
  try {
    new URL(`http://${host}`);
    return host;
  } catch {
    return null;
  }
}

/** The right-most non-empty value of a comma-separated header, trimmed; null when there is none. */
function lastValue(value: string | null): string | null {
  const values = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return values.at(-1) ?? null;
}
