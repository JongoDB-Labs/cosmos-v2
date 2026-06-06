/**
 * Security headers applied at the proxy edge. Tuned to support Next.js
 * App Router (which inlines small scripts at boot), Tailwind v4 (style
 * tags injected into <head>), and recharts/framer-motion (no eval needed
 * in modern builds).
 *
 * If you tighten `script-src` further, switch to a per-request nonce
 * threaded through the layout via the `x-csp-nonce` response header.
 */

const CSP_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline' is needed for the synchronous theme-init script that
  // runs before paint in src/app/layout.tsx. Switch to nonce-hash to
  // remove it when we wire request-scoped nonces.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://static.cloudflareinsights.com",
  // Tailwind v4 + base-ui inject style elements at runtime.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://*.googleusercontent.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Google APIs (OAuth, calendar, drive, gmail) + DocuSign + same-origin SSE.
  "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com https://docusign.net https://*.docusign.net https://cloudflareinsights.com",
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
