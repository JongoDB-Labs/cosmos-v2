// Where Cosmos may connect when someone else chose the URL, and for how long.
//
// Three tiers (public-address.ts): public addresses always; link-local and
// cloud metadata never; any other private address only for an endpoint an
// org admin configured, and only inside the ranges the OPERATOR lists in
// OUTBOUND_ALLOW_PRIVATE_CIDRS. And a request gives up after its deadline in
// total, not only after a quiet spell.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  isAllowedOutboundAddress,
  isPublicAddress,
  operatorPrivateRanges,
} from "./public-address";
import { fetchPublicUrl, requestPublicUrl, OutboundRefused } from "./outbound-post.server";

const ENV = "OUTBOUND_ALLOW_PRIVATE_CIDRS";
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("an IPv4 address written as IPv6 is never public", () => {
  it.each(["::ffff:8.8.8.8", "::ffff:808:808", "::8.8.8.8", "::808:808", "::ffff:0:8.8.8.8", "::ffff:0:127.0.0.1", "::127.0.0.1"])(
    "refuses %s",
    (ip) => expect(isPublicAddress(ip)).toBe(false),
  );
  it.each(["8.8.8.8", "2606:4700:4700::1111"])("still allows %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe("private addresses an operator allows, for configured endpoints only", () => {
  it("nothing private without the operator's list, even for a configured endpoint", () => {
    vi.stubEnv(ENV, "");
    expect(isAllowedOutboundAddress("10.20.1.2", { allowOperatorPrivate: true })).toBe(false);
    expect(isAllowedOutboundAddress("8.8.8.8", { allowOperatorPrivate: true })).toBe(true);
  });

  it("a configured endpoint reaches the listed ranges and nothing else private", () => {
    vi.stubEnv(ENV, "10.20.0.0/16, fd12:3456::/48");
    expect(isAllowedOutboundAddress("10.20.1.2", { allowOperatorPrivate: true })).toBe(true);
    expect(isAllowedOutboundAddress("fd12:3456::9", { allowOperatorPrivate: true })).toBe(true);
    expect(isAllowedOutboundAddress("10.21.0.1", { allowOperatorPrivate: true })).toBe(false);
    expect(isAllowedOutboundAddress("192.168.1.1", { allowOperatorPrivate: true })).toBe(false);
  });

  it("a webhook or fetch_url never does, whatever the operator lists", () => {
    vi.stubEnv(ENV, "10.20.0.0/16");
    expect(isAllowedOutboundAddress("10.20.1.2")).toBe(false);
    expect(isAllowedOutboundAddress("10.20.1.2", { allowOperatorPrivate: false })).toBe(false);
  });

  it.each(["169.254.169.254", "169.254.0.1", "fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe"])(
    "link-local and metadata %s stay unreachable even if the operator lists everything",
    (ip) => {
      vi.stubEnv(ENV, "0.0.0.0/0, ::/0, 169.254.0.0/16, fe80::/10, fd00::/8");
      expect(isAllowedOutboundAddress(ip, { allowOperatorPrivate: true })).toBe(false);
    },
  );

  it("a range that doesn't parse is an error, not a silent allow or deny", () => {
    expect(() => operatorPrivateRanges("10.0.0.0/8, nonsense")).toThrow(/not a CIDR/);
    expect(() => operatorPrivateRanges("10.0.0.0/40")).toThrow(/not a CIDR/);
  });
});

describe("requestPublicUrl", () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/drip") {
        // Never quiet for long, never finished quickly: an idle timer never fires.
        res.writeHead(200);
        let n = 0;
        const t = setInterval(() => {
          res.write("x");
          if (++n >= 30) {
            clearInterval(t);
            res.end();
          }
        }, 100);
        res.on("close", () => clearInterval(t));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://127.0.0.1/elsewhere" }).end();
      } else if (req.url === "/stream") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("one ");
        setTimeout(() => res.end("two"), 50);
      } else {
        res.writeHead(200).end("ok");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const local = { allowAddress: (ip: string) => ip === "127.0.0.1", resolve: async () => ["127.0.0.1"] };

  it("gives up after the deadline in total, even while bytes keep arriving", async () => {
    const t0 = Date.now();
    await expect(
      requestPublicUrl(`http://drip.example:${port}/drip`, { ...local, method: "GET", headers: {}, timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("the same slow response completes inside a longer deadline (control)", async () => {
    const r = await requestPublicUrl(`http://drip.example:${port}/drip`, { ...local, method: "GET", headers: {}, timeoutMs: 10_000 });
    expect(r.body).toBe("x".repeat(30));
  });

  it("refuses a metadata host name before looking it up", async () => {
    const resolve = vi.fn(async () => ["8.8.8.8"]);
    for (const u of ["http://metadata.google.internal./x", "http://METADATA/x", "http://instance-data/latest"]) {
      await expect(requestPublicUrl(u, { method: "GET", headers: {}, resolve })).rejects.toThrow(OutboundRefused);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a configured endpoint reaches a private address only inside the operator's ranges", async () => {
    const opts = { method: "GET" as const, headers: {}, resolve: async () => ["127.0.0.1"], allowOperatorPrivate: true };
    vi.stubEnv(ENV, "");
    await expect(requestPublicUrl(`http://llm.internal:${port}/`, opts)).rejects.toThrow(/isn't allowed|isn't public/);
    vi.stubEnv(ENV, "127.0.0.0/8");
    const r = await requestPublicUrl(`http://llm.internal:${port}/`, opts);
    expect(r).toMatchObject({ status: 200, body: "ok" });
    // ...and the same range is still closed to a webhook.
    await expect(requestPublicUrl(`http://llm.internal:${port}/`, { ...opts, allowOperatorPrivate: false })).rejects.toThrow(OutboundRefused);
  });
});

describe("fetchPublicUrl", () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") res.writeHead(302, { Location: "http://127.0.0.1/elsewhere" }).end();
      else if (req.url === "/stream") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("one ");
        setTimeout(() => res.end("two"), 50);
      } else res.writeHead(500).end("internal detail");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const local = { allowAddress: (ip: string) => ip === "127.0.0.1", resolve: async () => ["127.0.0.1"] };

  it("hands back a Response whose body streams", async () => {
    const res = await fetchPublicUrl(`http://llm.example:${port}/stream`, { method: "POST", body: "{}" }, local);
    expect(res.ok).toBe(true);
    const chunks: string[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value));
    }
    expect(chunks.join("")).toBe("one two");
  });

  it("returns a redirect as a failed response instead of following it", async () => {
    const res = await fetchPublicUrl(`http://llm.example:${port}/redirect`, { method: "GET" }, local);
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
  });

  it("refuses a link-local address without connecting", async () => {
    await expect(fetchPublicUrl("http://169.254.169.254/latest/meta-data/", { method: "GET" }, { allowOperatorPrivate: true })).rejects.toThrow(OutboundRefused);
  });
});
