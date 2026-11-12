import { configuredPublicOrigin } from "@/lib/integrations/microsoft/hosts";
import { servedAddresses } from "./served-addresses";

/**
 * Where to send a page visit that arrived at one of this instance's OTHER
 * addresses, or null to serve it where it is.
 *
 * For an instance mid-move between domains: Caddy serves both, and
 * `COSMOS_PUBLIC_URL` (the address people should reach it at) names the new
 * one. Unset, nothing changes. Cookies are per host, so someone sent across
 * signs in once at the new address.
 *
 * Narrow on purpose, because the old address still has callers that cannot
 * follow a redirect to another host:
 *
 * - Only GET and HEAD. A redirected POST is replayed or dropped depending on
 *   the client.
 * - Only from an address in `COSMOS_SITE_ADDRESS`. Requests by an internal
 *   name (the container's own hostname, localhost on the box) are never
 *   moved, and neither is a forged Host the instance isn't served at.
 * - Only pages. `/api/*` keeps working at every address: sign-in callbacks
 *   registered for the old one, API keys (a client may drop Authorization on a
 *   cross-host redirect), the Teams bot, calendar feeds that calendar servers
 *   poll, unsubscribe links. Also skipped: `/_next/*`, the Teams tabs (Teams
 *   lists the hosts a tab may navigate to), and any path ending in a file
 *   name, such as the service worker web-push subscriptions belong to.
 *
 * The caller answers 307, not 308. Browsers keep a permanent redirect for a
 * long time, so a 308 would outlive unsetting the variable.
 */
export function otherAddressRedirect(
  request: { method: string; host: string | null; pathname: string; search: string },
  publicOrigin: string | null = configuredPublicOrigin(),
  addresses: URL[] = servedAddresses(),
): string | null {
  if (!publicOrigin || !request.host) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const target = new URL(publicOrigin);
  if (sameHost(request.host, target)) return null;
  if (!addresses.some((address) => sameHost(request.host!, address))) return null;
  if (!isPage(request.pathname)) return null;
  return `${target.origin}${request.pathname}${request.search}`;
}

/**
 * A Host header against an address. Caddy forwards the host as the client
 * sent it, which omits a default port, and an address may name one.
 */
function sameHost(host: string, address: URL): boolean {
  const h = host.toLowerCase();
  return h === address.host || h === address.hostname;
}

function isPage(pathname: string): boolean {
  if (/^\/(api|_next|teams)(\/|$)/.test(pathname)) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}
