import ipaddr from "ipaddr.js";

/**
 * The client's IP address, read only from what the deployment's own edge proxy
 * wrote.
 *
 * A client can send any header it likes, so the address can only come from a
 * header the edge sets or appends to. The shipped Caddy (compose/Caddyfile)
 * sets X-Forwarded-For to the address it accepted the connection from and
 * drops whatever the client sent there; it passes other headers, such as
 * CF-Connecting-IP and X-Real-IP, through untouched. So by default the client
 * is the RIGHT-most X-Forwarded-For entry, the one the edge wrote, and never
 * the left-most, which a client can write when a proxy appends.
 *
 * A deployment with a different edge says which header its edge sets:
 *   TRUSTED_CLIENT_IP_HEADER  e.g. `CF-Connecting-IP` when a Cloudflare tunnel
 *                             is the only way in. Default: X-Forwarded-For.
 *   TRUSTED_PROXY_HOPS        how many trusted proxies append to that header,
 *                             counting the last one (default 1). The address is
 *                             the entry this many places from the right.
 * See .env.example.
 *
 * A blank setting counts as unset. Returns null when the header is missing,
 * the hop count isn't a whole number of at least 1, or the entry isn't an
 * address written the plain way (four decimal parts, or IPv6); an access check
 * treats that as no match. An IPv4 client reached over IPv6 comes back in its
 * IPv4 form, so it matches the IPv4 ranges an admin types.
 */
export function trustedClientIp(h: Headers, env: NodeJS.ProcessEnv = process.env): string | null {
  const { header, hops } = settings(env);
  if (hops === null) return null;
  const entries = (h.get(header) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = entries[entries.length - hops];
  if (!ip || !(ipaddr.IPv4.isValidFourPartDecimal(ip) || ipaddr.IPv6.isValid(ip))) return null;
  return ipaddr.process(ip).toString();
}

/** A header name, as HTTP defines a token. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** The two settings, read the one way every caller reads them. `hops` is null when unusable. */
function settings(env: NodeJS.ProcessEnv): { header: string; hops: number | null } {
  const header = env.TRUSTED_CLIENT_IP_HEADER?.trim() || "x-forwarded-for";
  const rawHops = env.TRUSTED_PROXY_HOPS?.trim();
  const hops = !rawHops ? 1 : /^\d+$/.test(rawHops) && Number(rawHops) >= 1 ? Number(rawHops) : null;
  return { header, hops };
}

/**
 * What is wrong with the two settings, one plain sentence each; empty when
 * nothing is. Checked at startup (instrumentation.ts) so a typo shows in the
 * log rather than as an allowlist that refuses everyone.
 */
export function clientIpConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const header = env.TRUSTED_CLIENT_IP_HEADER?.trim();
  if (header && !HEADER_NAME.test(header)) {
    problems.push(`TRUSTED_CLIENT_IP_HEADER "${header}" is not a header name, so no request carries it and the IP allowlist will refuse everyone.`);
  }
  if (settings(env).hops === null) {
    problems.push(`TRUSTED_PROXY_HOPS "${env.TRUSTED_PROXY_HOPS}" is not a whole number of at least 1, so the IP allowlist will refuse everyone.`);
  }
  return problems;
}

/** Whether the deployment named its edge's header (either setting is set). */
export function clientIpHeaderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.TRUSTED_CLIENT_IP_HEADER?.trim() || env.TRUSTED_PROXY_HOPS?.trim());
}

/**
 * The address to record in the audit log or key a rate limit by. The trusted
 * address once the deployment has named its edge's header; until then, or when
 * that address can't be read, the left-most X-Forwarded-For entry, then
 * X-Real-IP, as before. Those uses decide no access, and falling back keeps
 * callers apart: answering nothing would put every such caller in one
 * rate-limit bucket.
 */
export function clientIpForRecords(h: Headers, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const trusted = clientIpHeaderConfigured(env) ? trustedClientIp(h, env) : null;
  const leftMost = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return trusted ?? (leftMost || h.get("x-real-ip")?.trim() || undefined);
}
