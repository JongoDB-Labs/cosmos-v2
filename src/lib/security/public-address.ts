/**
 * Which addresses Cosmos may connect to when someone else chose the URL: a
 * webhook, Cosmo's fetch_url, or an endpoint an org admin configured (a Jira
 * site, an OpenAI-compatible model endpoint, an MCP server). One list, used
 * both when a URL is saved (for an address written into it) and when it is
 * sent (outbound-post.server.ts, for every address its name resolves to).
 *
 * Three tiers:
 *   - public addresses: allowed;
 *   - link-local and cloud metadata (169.254/16, fe80::/10, fd00:ec2::254, and
 *     the metadata host names): NEVER allowed, whatever is configured;
 *   - every other address that isn't public (private, loopback, CGNAT, ULA...):
 *     refused, except for an endpoint an org admin configured when the
 *     OPERATOR lists its range in OUTBOUND_ALLOW_PRIVATE_CIDRS. That is an
 *     instance environment variable, never an org setting: a self-hosted model
 *     or Jira on a private network is a real deployment, and only whoever runs
 *     the instance can say which of its networks a tenant may reach.
 */
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
// An IPv4 address in IPv6 clothing is never sent to, public or not:
// IPv4-compatible (::a.b.c.d, which also covers :: and ::1), IPv4-mapped
// (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d). A list of its own,
// consulted only for an IPv6 address: BlockList matches a plain IPv4 address
// against ::ffff:0:0/96 too, which would refuse every IPv4 address.
const v4InV6 = new BlockList();
for (const [net, prefix] of [["::", 96], ["::ffff:0:0", 96], ["::ffff:0:0:0", 96]] as const) v4InV6.addSubnet(net, prefix, "ipv6");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** Never reachable, even from an endpoint the operator allowed private ranges for. */
const neverAllowed = new BlockList();
neverAllowed.addSubnet("169.254.0.0", 16, "ipv4");
neverAllowed.addSubnet("fe80::", 10, "ipv6");
neverAllowed.addAddress("fd00:ec2::254", "ipv6");
// Link-local carried inside NAT64 (every other IPv4-in-IPv6 form is refused
// outright by v4InV6).
neverAllowed.addSubnet("64:ff9b::a9fe:0", 112, "ipv6");

/** Cloud metadata services by name. Compared without case or a trailing dot. */
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** A host name as compared: lower case, without the trailing dot DNS allows. */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** True for a cloud metadata service's name. */
export function isMetadataHostname(hostname: string): boolean {
  return METADATA_HOSTNAMES.has(normalizeHostname(hostname));
}

const familyOf = (ip: string): "ipv4" | "ipv6" | null => {
  const f = isIP(ip);
  return f === 4 ? "ipv4" : f === 6 ? "ipv6" : null;
};

/** True for an address on the public internet; false for anything else, or not an address. */
export function isPublicAddress(ip: string): boolean {
  const family = familyOf(ip);
  if (family === "ipv6" && v4InV6.check(ip, "ipv6")) return false;
  return family !== null && !blocked.check(ip, family);
}

/** True for link-local and metadata addresses, which nothing may reach; and for anything not an address. */
export function isNeverAllowedAddress(ip: string): boolean {
  const family = familyOf(ip);
  return family === null || neverAllowed.check(ip, family);
}

/** True for an IPv4 address written as IPv6, which is never connected to. */
function isV4InV6(ip: string): boolean {
  return familyOf(ip) === "ipv6" && v4InV6.check(ip, "ipv6");
}

let cachedSpec: string | undefined;
let cachedList: BlockList | null = null;

/**
 * The operator's private ranges, from OUTBOUND_ALLOW_PRIVATE_CIDRS
 * (comma-separated, e.g. "10.20.0.0/16,fd12:3456::/48"), or null when unset.
 * An entry that doesn't parse throws, so a typo is loud rather than quietly
 * allowing nothing, or everything.
 */
export function operatorPrivateRanges(spec = process.env.OUTBOUND_ALLOW_PRIVATE_CIDRS): BlockList | null {
  const text = (spec ?? "").trim();
  if (!text) return null;
  if (text === cachedSpec) return cachedList;
  const list = new BlockList();
  for (const raw of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^/\s]+)\/(\d{1,3})$/.exec(raw);
    const family = m ? familyOf(m[1]) : null;
    const prefix = m ? Number(m[2]) : NaN;
    if (!m || !family || prefix > (family === "ipv4" ? 32 : 128)) {
      throw new Error(`OUTBOUND_ALLOW_PRIVATE_CIDRS: "${raw}" is not a CIDR range like 10.0.0.0/8`);
    }
    list.addSubnet(m[1], prefix, family);
  }
  cachedSpec = text;
  cachedList = list;
  return list;
}

export interface OutboundAddressPolicy {
  /**
   * The URL is an endpoint an org admin configured (Jira, a model endpoint, an
   * MCP server): a private address inside the operator's
   * OUTBOUND_ALLOW_PRIVATE_CIDRS is allowed. Never for webhooks or fetch_url.
   */
  allowOperatorPrivate?: boolean;
}

/** May Cosmos connect to `ip` under `policy`? */
export function isAllowedOutboundAddress(ip: string, policy: OutboundAddressPolicy = {}): boolean {
  const family = familyOf(ip);
  if (!family || isNeverAllowedAddress(ip) || isV4InV6(ip)) return false;
  if (isPublicAddress(ip)) return true;
  if (!policy.allowOperatorPrivate) return false;
  return operatorPrivateRanges()?.check(ip, family) ?? false;
}

/** A URL's hostname as an address (an IPv6 literal without its brackets), or null for a name. */
export function hostAddress(hostname: string): string | null {
  const host = hostname.replace(/^\[|\]$/g, "");
  return isIP(host) ? host : null;
}

/**
 * Why a URL can't be saved as an outbound endpoint, from its text alone, or
 * null. A name is checked again when the request is sent, against every
 * address it then resolves to; this is the early, readable refusal.
 */
export function outboundUrlProblem(url: string, policy: OutboundAddressPolicy = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Not a valid URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Only http and https URLs are allowed";
  if (parsed.username || parsed.password) return "URLs with credentials are not allowed";
  const host = normalizeHostname(parsed.hostname);
  if (isMetadataHostname(host)) return "Cloud metadata addresses are never allowed";
  const address = hostAddress(host);
  if (address) {
    if (isNeverAllowedAddress(address)) return "Link-local and metadata addresses are never allowed";
    if (!isAllowedOutboundAddress(address, policy)) return "That address isn't public";
    return null;
  }
  // localhost is loopback by definition: allowed only where 127.0.0.1 would be.
  if ((host === "localhost" || host.endsWith(".localhost")) && !isAllowedOutboundAddress("127.0.0.1", policy)) {
    return "That address isn't public";
  }
  return null;
}
