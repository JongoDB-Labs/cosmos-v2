// @vitest-environment node
//
// An instance mid-move between domains is served at both. Page visits at the
// old one go to COSMOS_PUBLIC_URL; everything that can't follow a redirect to
// another host keeps working where it is. Each "stays" case below is a caller
// that would break if it were moved.
import { describe, it, expect } from "vitest";
import { otherAddressRedirect } from "./other-address-redirect";
import { servedAddresses } from "./served-addresses";

const PUBLIC = "https://cosmos.example.dev";
const BOTH = servedAddresses("cosmos.example.net, cosmos.example.dev");

const visit = (
  pathname: string,
  { host = "cosmos.example.net", method = "GET", search = "" }: { host?: string | null; method?: string; search?: string } = {},
) => otherAddressRedirect({ method, host, pathname, search }, PUBLIC, BOTH);

describe("otherAddressRedirect", () => {
  it("sends a page visit at the other address to the same page at the public one", () => {
    expect(visit("/acme/program-management")).toBe("https://cosmos.example.dev/acme/program-management");
    expect(visit("/")).toBe("https://cosmos.example.dev/");
    expect(visit("/login")).toBe("https://cosmos.example.dev/login");
    expect(visit("/acme/items", { search: "?q=open&page=2" })).toBe("https://cosmos.example.dev/acme/items?q=open&page=2");
    expect(visit("/acme", { method: "HEAD" })).toBe("https://cosmos.example.dev/acme");
  });

  it("control: a visit at the public address stays", () => {
    expect(visit("/acme", { host: "cosmos.example.dev" })).toBeNull();
    expect(visit("/acme", { host: "COSMOS.example.dev" })).toBeNull();
  });

  it("leaves every API path where it is: callbacks, API keys, the Teams bot, calendar feeds", () => {
    for (const path of ["/api/health", "/api/auth/microsoft/callback", "/api/v1/orgs/o1/projects", "/api/teams/bot", "/api/v1/calendar/feeds/t0k3n", "/api"]) {
      expect(visit(path), path).toBeNull();
    }
  });

  it("leaves Next's own assets, the Teams tabs and files such as the service worker", () => {
    for (const path of ["/_next/data/x.json", "/_next/image", "/teams/tab/acme", "/sw.js", "/manifest.webmanifest", "/robots.txt", "/favicon.ico"]) {
      expect(visit(path), path).toBeNull();
    }
  });

  it("only moves GET and HEAD: a redirected POST is replayed or dropped by the client", () => {
    expect(visit("/acme", { method: "POST" })).toBeNull();
    expect(visit("/acme", { method: "OPTIONS" })).toBeNull();
  });

  it("only moves a visit at an address the instance is served at", () => {
    // The container's own name, the box's loopback, a forged Host.
    for (const host of ["cosmos:3000", "localhost:3000", "127.0.0.1:3000", "evil.example.com", null]) {
      expect(visit("/acme", { host }), String(host)).toBeNull();
    }
  });

  it("does nothing until the public URL is set", () => {
    expect(otherAddressRedirect({ method: "GET", host: "cosmos.example.net", pathname: "/acme", search: "" }, null, BOTH)).toBeNull();
  });

  it("matches an address that names a port, with or without it in the Host header", () => {
    const withPort = servedAddresses("https://cosmos.example.net:8443 cosmos.example.dev");
    const go = (host: string) => otherAddressRedirect({ method: "GET", host, pathname: "/acme", search: "" }, PUBLIC, withPort);
    expect(go("cosmos.example.net:8443")).toBe("https://cosmos.example.dev/acme");
    expect(go("cosmos.example.net")).toBe("https://cosmos.example.dev/acme");
  });
});

describe("servedAddresses", () => {
  const hosts = (raw: string | undefined) => servedAddresses(raw).map((u) => u.host);

  it("reads Caddy's site-address forms", () => {
    expect(hosts("a.example.net, a.example.dev")).toEqual(["a.example.net", "a.example.dev"]);
    expect(hosts("a.example.net a.example.dev")).toEqual(["a.example.net", "a.example.dev"]);
    expect(hosts('"a.example.net, a.example.dev"')).toEqual(["a.example.net", "a.example.dev"]);
    expect(hosts("https://a.example.net:8443")).toEqual(["a.example.net:8443"]);
  });

  it("skips entries that name no host, and is empty when unset", () => {
    expect(hosts(":80")).toEqual([]);
    expect(hosts("*.example.dev")).toEqual([]);
    expect(hosts(undefined)).toEqual([]);
    expect(hosts("")).toEqual([]);
  });
});
