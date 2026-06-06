import type { NextRequest } from "next/server";

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
export function getPublicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const hostHeader = request.headers.get("host");

  const host = forwardedHost ?? hostHeader;
  if (host) {
    const proto =
      forwardedProto ??
      (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${proto}://${host}`;
  }

  // Last-resort fallback — should be unreachable in practice
  return new URL(request.url).origin;
}
