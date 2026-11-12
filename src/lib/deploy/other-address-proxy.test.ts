// The redirect wired into the real proxy: it runs before the session check, so
// a signed-out visitor at the old address signs in at the new one, and it is
// inert until COSMOS_PUBLIC_URL is set.
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { proxy } from "@/proxy";

const get = (path: string, host: string) =>
  new NextRequest(new URL(path, "http://cosmos:3000"), { headers: { host: "cosmos:3000", "x-forwarded-host": host, "x-forwarded-proto": "https" } });

function configure() {
  process.env.COSMOS_PUBLIC_URL = "https://cosmos.example.dev";
  process.env.COSMOS_SITE_ADDRESS = "cosmos.example.net, cosmos.example.dev";
}

afterEach(() => {
  delete process.env.COSMOS_PUBLIC_URL;
  delete process.env.COSMOS_SITE_ADDRESS;
});

describe("proxy: page visits at another address", () => {
  it("redirects a page at the other address to the public one, before the sign-in check", async () => {
    configure();
    const res = await proxy(get("/acme/program-management?project=X", "cosmos.example.net"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://cosmos.example.dev/acme/program-management?project=X");
  });

  it("control: at the public address the usual sign-in redirect happens instead", async () => {
    configure();
    const res = await proxy(get("/acme/program-management", "cosmos.example.dev"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("serves the API at the other address as before", async () => {
    configure();
    const res = await proxy(get("/api/health", "cosmos.example.net"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not redirect where Next would turn it into a loop", async () => {
    // Next makes a redirect to its own internal host relative, which lands the
    // visitor back at the address they came from. Measured locally: 307 with
    // `Location: /acme` until the browser gave up.
    configure();
    const internal = new NextRequest(new URL("/acme", "https://cosmos.example.dev"), {
      headers: { host: "cosmos.example.dev", "x-forwarded-host": "cosmos.example.net" },
    });
    const res = await proxy(internal);
    expect(new URL(res.headers.get("location")!, "https://x").pathname).toBe("/login");
  });

  it("is inert while COSMOS_PUBLIC_URL is unset", async () => {
    process.env.COSMOS_SITE_ADDRESS = "cosmos.example.net, cosmos.example.dev";
    const res = await proxy(get("/acme", "cosmos.example.net"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
