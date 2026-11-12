/**
 * The addresses this instance is served at, from `COSMOS_SITE_ADDRESS`: the
 * list Caddy takes as its site address (compose/Caddyfile), which the app
 * reads from the same env file. Set when Caddy terminates TLS; unset (Caddy on
 * plain :80) it lists nothing.
 *
 * Caddy's format: separated by commas or spaces (quotes from an env file
 * tolerated), scheme optional and https when absent. A port-only entry (":80")
 * or a wildcard names no host anyone can be sent to, so it is skipped.
 *
 * Two readers, both of which only ever send someone to an address from this
 * list, so neither is an open redirect:
 *   - src/lib/pm/embed.ts, which picks the address on an outside dashboard's
 *     site, and
 *   - src/lib/deploy/other-address-redirect.ts, which sends page visits at
 *     the other addresses to `COSMOS_PUBLIC_URL`.
 */
export function servedAddresses(raw: string | undefined = process.env.COSMOS_SITE_ADDRESS): URL[] {
  const out: URL[] = [];
  for (const token of (raw ?? "").split(/[\s,"']+/)) {
    if (!token || token.startsWith(":") || token.includes("*")) continue;
    try {
      out.push(new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : `https://${token}`));
    } catch {
      // Not an address.
    }
  }
  return out;
}
