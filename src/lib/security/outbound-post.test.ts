import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isPublicAddress, postToPublicUrl, OutboundRefused } from "./outbound-post.server";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.10",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "64:ff9b::a00:1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
    "not-an-ip", "",
  ])("refuses %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe("postToPublicUrl", () => {
  let server: http.Server;
  let port: number;
  const seen: { host?: string; body: string; method?: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ host: req.headers.host, body, method: req.method });
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "http://127.0.0.1/elsewhere" }).end();
        } else if (req.url === "/big") {
          res.writeHead(200).end("x".repeat(5000));
        } else if (req.url === "/slow") {
          setTimeout(() => res.writeHead(200).end("late"), 500);
        } else {
          res.writeHead(201).end("ok");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const local = { allowAddress: (ip: string) => ip === "127.0.0.1", resolve: async () => ["127.0.0.1"] };

  it("connects to the address it checked, under the URL's own host name", async () => {
    const r = await postToPublicUrl(`http://hooks.example:${port}/in`, { ...local, headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
    expect(r).toEqual({ status: 201, body: "ok" });
    expect(seen.at(-1)).toMatchObject({ host: `hooks.example:${port}`, body: '{"a":1}', method: "POST" });
  });

  it("refuses a name that resolves to a private address, without connecting", async () => {
    const before = seen.length;
    await expect(
      postToPublicUrl(`http://hooks.example:${port}/in`, { resolve: async () => ["127.0.0.1"], headers: {}, body: "{}" }),
    ).rejects.toThrow(OutboundRefused);
    expect(seen.length).toBe(before);
  });

  it("refuses when any one of the addresses isn't public", async () => {
    await expect(
      postToPublicUrl("https://hooks.example/in", { resolve: async () => ["8.8.8.8", "10.0.0.5"], headers: {}, body: "{}" }),
    ).rejects.toThrow(/isn't public/);
  });

  it("refuses an address literal inside the network, and a URL with credentials or another scheme", async () => {
    await expect(postToPublicUrl("http://169.254.169.254/latest", { headers: {}, body: "" })).rejects.toThrow(/isn't public/);
    await expect(postToPublicUrl("http://[::1]:8080/", { headers: {}, body: "" })).rejects.toThrow(/isn't public/);
    await expect(postToPublicUrl("https://u:p@hooks.example/", { headers: {}, body: "" })).rejects.toThrow(/credentials/);
    await expect(postToPublicUrl("file:///etc/passwd", { headers: {}, body: "" })).rejects.toThrow(/http and https/);
  });

  it("returns a redirect instead of following it", async () => {
    const before = seen.length;
    const r = await postToPublicUrl(`http://hooks.example:${port}/redirect`, { ...local, headers: {}, body: "{}" });
    expect(r.status).toBe(302);
    expect(seen.length).toBe(before + 1);
  });

  it("keeps at most 1000 characters of the response, and gives up on a slow one", async () => {
    const big = await postToPublicUrl(`http://hooks.example:${port}/big`, { ...local, headers: {}, body: "" });
    expect(big.body.length).toBe(1000);
    await expect(postToPublicUrl(`http://hooks.example:${port}/slow`, { ...local, headers: {}, body: "", timeoutMs: 100 })).rejects.toThrow(/Timed out/);
  });
});
