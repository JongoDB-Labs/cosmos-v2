/**
 * POST to a URL someone outside Cosmos chose (a webhook), without letting that
 * URL reach anything inside the network Cosmos runs in.
 *
 * `webhookUrlSchema` checks a URL when it is saved, but only its text: a public
 * name can resolve to a private address, today or after its DNS changes, and a
 * public endpoint can redirect anywhere. So at send time this:
 *   - resolves the name and refuses if ANY address it resolves to is not public
 *     (loopback, private, link-local, CGNAT, multicast, reserved, documentation,
 *     unique-local, IPv4-mapped or NAT64 forms of those);
 *   - connects to the address it checked, not to a second lookup that could
 *     answer differently (DNS rebinding); TLS still verifies the hostname;
 *   - never follows a redirect (a 3xx is returned as the result, not followed);
 *   - gives up after `timeoutMs` and keeps at most MAX_BODY characters of the
 *     response.
 * Node's http/https with a pinned `lookup`, so no dependency.
 */
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_BODY = 1000;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** True for an address on the public internet; false for anything else, or not an address. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  // An IPv4-mapped address (::ffff:a.b.c.d, or its hex form) is checked
  // against the IPv4 rules by BlockList itself; outbound-post.test.ts pins it.
  return family === 6 && !blocked.check(ip, "ipv6");
}

/** The URL was not sent: why, in words fit for a delivery log. */
export class OutboundRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRefused";
  }
}

export interface OutboundResult {
  status: number;
  /** At most MAX_BODY characters. */
  body: string;
}

export interface PostOptions {
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tests only: resolve names without DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Tests only: allow a local address, to reach a server the test runs. */
  allowAddress?: (ip: string) => boolean;
}

const resolveAll = async (hostname: string) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** POST `body` to `url` under the rules above. Throws OutboundRefused when it won't send. */
export async function postToPublicUrl(url: string, opts: PostOptions): Promise<OutboundResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new OutboundRefused("Not a valid URL");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new OutboundRefused("Only http and https URLs are allowed");
  if (target.username || target.password) throw new OutboundRefused("URLs with credentials are not allowed");

  const allowed = opts.allowAddress ?? isPublicAddress;
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(hostname)) addresses = [hostname];
  else {
    try {
      addresses = await (opts.resolve ?? resolveAll)(hostname);
    } catch {
      throw new OutboundRefused(`Couldn't resolve ${hostname}`);
    }
  }
  if (addresses.length === 0) throw new OutboundRefused(`Couldn't resolve ${hostname}`);
  // Every answer, not just the first: a name that also resolves inside the
  // network is refused outright rather than raced.
  if (!addresses.every(allowed)) throw new OutboundRefused(`${hostname} resolves to an address that isn't public`);
  const pinned = addresses[0];
  const family = isIP(pinned);

  const client = target.protocol === "https:" ? https : http;
  return new Promise<OutboundResult>((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "POST",
        headers: { ...opts.headers, "Content-Length": Buffer.byteLength(opts.body).toString() },
        // Connect to the address checked above, whatever DNS says now.
        lookup: (_host, options, cb) => {
          if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pinned, family }]);
          else cb(null, pinned, family);
        },
        signal: opts.signal,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < MAX_BODY) body += chunk;
          if (body.length >= MAX_BODY) res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, MAX_BODY) });
        res.on("end", done);
        res.on("close", done);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 10_000, () => req.destroy(new OutboundRefused("Timed out")));
    req.on("error", (e) => reject(e instanceof OutboundRefused ? e : new OutboundRefused(e.message)));
    req.end(opts.body);
  });
}
