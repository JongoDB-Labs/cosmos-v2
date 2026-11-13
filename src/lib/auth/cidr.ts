import ipaddr from "ipaddr.js";

/**
 * Validate and canonicalize a CIDR string for storage in an IP allowlist.
 * Accepts proper CIDR (`10.0.0.0/8`, `2001:db8::/32`) and a bare IP address
 * (normalized to a host route — `/32` for IPv4, `/128` for IPv6) so an admin who
 * types a single address isn't silently storing an entry that matches nobody.
 * Returns the normalized `address/bits` string, or null when unparseable.
 *
 * Rejecting garbage here is the anti-lockout guard: enforcement treats an
 * enabled-but-all-unparseable allowlist as "deny everyone", so we must never let
 * a malformed entry reach the table.
 */
export function normalizeCidr(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // Proper CIDR first.
  if (raw.includes("/")) {
    try {
      const [net, bits] = asIPv4IfMapped(ipaddr.parseCIDR(raw));
      return `${net.toNormalizedString()}/${bits}`;
    } catch {
      return null;
    }
  }
  // Bare IP → host route.
  try {
    const addr = ipaddr.process(raw);
    const bits = addr.kind() === "ipv6" ? 128 : 32;
    return `${addr.toNormalizedString()}/${bits}`;
  } catch {
    return null;
  }
}

/**
 * True when `ip` falls within ANY of the given CIDR ranges. Handles IPv4, IPv6,
 * and IPv4-mapped IPv6 (normalized via ipaddr.process). Unparseable client IP or
 * a malformed CIDR contributes no match — for an allowlist that means "deny",
 * which is correct; the admin configuring it stays break-glass-exempt elsewhere.
 */
export function ipMatchesAny(ip: string, cidrs: string[]): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip.trim());
  } catch {
    return false;
  }
  for (const cidr of cidrs) {
    try {
      // An IPv4-mapped IPv6 network becomes the IPv4 range it stands for, so it
      // can match an IPv4 client (ipaddr requires both operands be the same kind).
      const [net, bits] = asIPv4IfMapped(ipaddr.parseCIDR(cidr.trim()));
      // Narrow with instanceof so each `match` call resolves to a single
      // concrete overload — TypeScript can't call the IPv4|IPv6 union of the
      // overloaded `match` method, and a runtime kind() check doesn't narrow.
      if (addr instanceof ipaddr.IPv4 && net instanceof ipaddr.IPv4) {
        if (addr.match([net, bits])) return true;
      } else if (addr instanceof ipaddr.IPv6 && net instanceof ipaddr.IPv6) {
        if (addr.match([net, bits])) return true;
      } else if (addr instanceof ipaddr.IPv4 && net instanceof ipaddr.IPv6) {
        // A range wider than the mapped block can still hold an IPv4 client's mapped form.
        if (addr.toIPv4MappedAddress().match([net, bits])) return true;
      }
    } catch {
      // skip malformed CIDR entries
    }
  }
  return false;
}

/**
 * An IPv4-mapped IPv6 network (`::ffff:a.b.c.d/n`, n >= 96) as the IPv4 range
 * it means (`a.b.c.d/(n-96)`). Keeping the IPv6 prefix length on an IPv4
 * address would ask for a /120 of a 32-bit address, which matches nothing.
 */
function asIPv4IfMapped([net, bits]: [ipaddr.IPv4 | ipaddr.IPv6, number]): [ipaddr.IPv4 | ipaddr.IPv6, number] {
  if (net instanceof ipaddr.IPv6 && net.isIPv4MappedAddress() && bits >= 96) return [net.toIPv4Address(), bits - 96];
  return [net, bits];
}
