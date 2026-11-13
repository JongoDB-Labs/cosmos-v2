// @vitest-environment node
//
// fetch_url (Cosmo's tool) fetches a URL a chat message chose, from inside the
// network Cosmos runs in. It must not reach an address there: not one written
// into the URL in any spelling, and not one a public-looking name resolves to.
// It sends through the same checked, pinned path as a webhook delivery.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => ({ allowLoopback: false, names: new Map<string, string>() }));

// Names resolve without real DNS: `intranet.example` and `public.example`
// stand for a public-looking name whose answer is an address in here.
vi.mock("node:dns", async (orig) => {
  const real = await orig<typeof import("node:dns")>();
  const lookup = async (host: string, opts: unknown) => {
    const ip = h.names.get(host);
    if (ip) return [{ address: ip, family: ip.includes(":") ? 6 : 4 }];
    return real.promises.lookup(host, opts as never);
  };
  const promises = { ...real.promises, lookup };
  return { ...real, promises, default: { ...real, promises } };
});

// Only the positive controls let the loopback address count as public, so a
// test server can stand in for a page on the internet.
vi.mock("@/lib/security/public-address", async (orig) => {
  const real = await orig<typeof import("@/lib/security/public-address")>();
  const loopback = (ip: string) => h.allowLoopback && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");
  return {
    ...real,
    isPublicAddress: (ip: string) => loopback(ip) || real.isPublicAddress(ip),
    isAllowedOutboundAddress: (ip: string, policy?: { allowOperatorPrivate?: boolean }) =>
      loopback(ip) || real.isAllowedOutboundAddress(ip, policy),
  };
});

import { fetchUrl } from "./utility";
import type { ToolContext } from "./_ctx";

const ctx = {} as ToolContext;
let server: http.Server;
let port = 0;
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/redirect") res.writeHead(302, { Location: "http://127.0.0.1/" }).end();
    else res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Hello <b>page</b></p>");
  });
  // Dual stack, so an IPv4-mapped or IPv6 loopback literal reaches it too.
  await new Promise<void>((r) => server.listen({ port: 0, host: "::", ipv6Only: false }, r));
  port = (server.address() as AddressInfo).port;
  h.names.set("intranet.example", "127.0.0.1");
  h.names.set("public.example", "127.0.0.1");
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  h.allowLoopback = false;
  seen.length = 0;
});

describe("fetch_url refuses an address inside the network", () => {
  it.each([
    ["an IPv4-mapped loopback literal", () => `http://[::ffff:127.0.0.1]:${port}/secret`],
    ["the IPv6 loopback literal", () => `http://[::1]:${port}/secret`],
    ["a name that resolves to loopback", () => `http://intranet.example:${port}/secret`],
  ])("%s: refused, and nothing is sent", async (_what, url) => {
    const r = (await fetchUrl({ url: url() }, ctx)) as { error?: string; text?: string };
    expect(r.error).toBeTruthy();
    expect(r.text).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("fetch_url still fetches a public page (positive control)", () => {
  it("returns the page as text", async () => {
    h.allowLoopback = true;
    const r = (await fetchUrl({ url: `http://public.example:${port}/page` }, ctx)) as { status?: number; text?: string; contentType?: string };
    expect(r).toMatchObject({ status: 200, text: "Hello page", contentType: "text/html" });
    expect(seen).toEqual(["/page"]);
  });

  it("doesn't follow a redirect", async () => {
    h.allowLoopback = true;
    const r = (await fetchUrl({ url: `http://public.example:${port}/redirect` }, ctx)) as { error?: string };
    expect(r.error).toMatch(/redirect/i);
    expect(seen).toEqual(["/redirect"]);
  });
});
