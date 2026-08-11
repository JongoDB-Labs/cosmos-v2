/**
 * Security headers applied at the proxy edge. Tuned to support Next.js
 * App Router (which inlines small scripts at boot), Tailwind v4 (style
 * tags injected into <head>), and recharts/framer-motion (no eval needed
 * in modern builds).
 *
 * If you tighten `script-src` further, switch to a per-request nonce
 * threaded through the layout via the `x-csp-nonce` response header.
 */

/**
 * Realtime sidecar origins, added to `connect-src` ONLY when configured.
 *
 * `'self'` already covers a same-origin `wss://` under CSP3, which is how the
 * sidecars are deployed today (`wss://<host>/whiteboard/realtime`). But
 * `*_REALTIME_URL` openly allows pointing at a sidecar on ANOTHER host, and then
 * the socket is refused with "violates the following Content Security Policy
 * directive: connect-src". Observed exactly that with a cross-origin sidecar:
 * the board still renders (realtime is best-effort by design) and the only
 * evidence is a console line nobody is watching — collaboration silently off.
 *
 * Deliberately NOT solved with a blanket `ws: wss:`. That would permit a socket
 * to ANY host on the internet, which on a CUI-adjacent deployment trades a
 * narrow configuration problem for a broad exfiltration path. Only the origins this instance
 * is actually configured to use are named, and only if they are set.
 */
function realtimeOrigins(): string[] {
  const urls = [
    process.env.WHITEBOARD_REALTIME_URL,
    process.env.PI_PLANNING_REALTIME_URL,
  ];
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      // Origin only — never the path. A CSP source is host-scoped.
      out.add(new URL(u).origin);
    } catch {
      // A malformed URL must not take the whole header down: skip it. The
      // feature it belongs to will fail loudly on its own.
    }
  }
  return [...out];
}

const CSP_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline' is needed for the synchronous theme-init script that
  // runs before paint in src/app/layout.tsx. Switch to nonce-hash to
  // remove it when we wire request-scoped nonces.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://static.cloudflareinsights.com",
  // Tailwind v4 + base-ui inject style elements at runtime.
  //
  // fonts.googleapis.com and fonts.gstatic.com were removed here on 2026-08-10
  // when the faces moved to next/font/local (src/app/fonts/). They were only
  // ever present to permit Google's font CSS and woff2 files; with the fonts
  // self-hosted, nothing requests either origin, so allowing them would grant
  // reach the app no longer uses. A CSP that lists origins it does not need is
  // a slow leak of exactly the property it exists to provide.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://*.googleusercontent.com",
  "font-src 'self' data:",
  // Google APIs (OAuth, calendar, drive, gmail) + DocuSign + same-origin SSE.
  [
    "connect-src 'self'",
    ...realtimeOrigins(),
    "https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com https://docusign.net https://*.docusign.net https://cloudflareinsights.com",
  ].join(" "),
  "frame-src 'self' https://accounts.google.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
];

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP_DIRECTIVES.join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  "Strict-Transport-Security":
    "max-age=63072000; includeSubDomains; preload",
};

export function applySecurityHeaders(headers: Headers): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }
}
