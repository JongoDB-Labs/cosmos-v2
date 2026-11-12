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
 * `headers()` rather than a Request. Null when neither host header is present.
 */
export function publicOriginFromHeaders(headers: Pick<Headers, "get">): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return null;
  const proto =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
