// @vitest-environment node
//
// Each provider's sign-in start keeps the page the visitor came from (`?next=`)
// in a short-lived cookie for its callback, and clears one an abandoned sign-in
// left behind. When the start itself refuses, the sign-in page it sends the
// visitor back to keeps the address, so the next try still lands there.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as oidc from "openid-client";

const h = vi.hoisted(() => ({
  msEnabled: true,
  org: null as null | { id: string; idpConnection: Record<string, unknown> },
}));

vi.mock("@/lib/auth/google-oauth", () => ({
  googleSignInUrl: async (_req: unknown, state: string) => `https://accounts.google.example/auth?state=${state}`,
}));
vi.mock("@/lib/auth/provider-config", () => ({
  getProviderConfig: async () =>
    h.msEnabled ? { enabled: true, clientId: "ms-client", clientSecret: "x", tenant: "common", trustedDomains: [] } : null,
}));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique: vi.fn(async () => h.org) } } }));
vi.mock("@/lib/auth/sso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/sso")>()),
  getOidcConfig: async () =>
    new oidc.Configuration({ issuer: "https://idp.example", authorization_endpoint: "https://idp.example/authorize" }, "client"),
}));

import { RETURN_TO_COOKIE } from "@/lib/auth/return-to";
import { GET as googleStart } from "./google/route";
import { GET as microsoftStart } from "./microsoft/route";
import { GET as ssoStart } from "./sso/[orgSlug]/login/route";

const DEEP = "/acme/issues?view=list";
let ip = 0;

function req(path: string, search: string, cookie = "") {
  return new NextRequest(`http://localhost:3000${path}${search}`, {
    headers: { host: "localhost:3000", "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(cookie ? { cookie } : {}) },
  });
}

const starts = [
  ["Google", (search: string, cookie?: string) => googleStart(req("/api/auth/google", search, cookie))],
  ["Microsoft", (search: string, cookie?: string) => microsoftStart(req("/api/auth/microsoft", search, cookie))],
  [
    "SSO",
    (search: string, cookie?: string) =>
      ssoStart(req("/api/auth/sso/acme/login", search, cookie), { params: Promise.resolve({ orgSlug: "acme" }) }),
  ],
] as const;

beforeEach(() => {
  h.msEnabled = true;
  h.org = { id: "org-1", idpConnection: { enabled: true, issuerUrl: "https://idp.example", scopes: [], requiredAcr: null } };
});

describe.each(starts)("%s sign-in start", (_name, start) => {
  it("keeps the return address for the callback", async () => {
    const res = await start(`?next=${encodeURIComponent(DEEP)}`);
    // Positive control: this really is the hand-off to the provider.
    expect(new URL(res.headers.get("location")!).hostname).not.toBe("localhost");
    expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe(DEEP);
  });

  it("clears a return address an earlier sign-in left behind", async () => {
    const res = await start("", `${RETURN_TO_COOKIE}=${encodeURIComponent("/old/page")}`);
    expect(new URL(res.headers.get("location")!).hostname).not.toBe("localhost");
    expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
  });

  it("keeps nothing for an address that is not a page on this site", async () => {
    const res = await start(`?next=${encodeURIComponent("//elsewhere.example/acme")}`);
    expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
  });
});

describe("a refused start keeps the return address on the sign-in page", () => {
  it("Microsoft, when it isn't configured", async () => {
    h.msEnabled = false;
    const location = new URL((await starts[1][1](`?next=${encodeURIComponent(DEEP)}`)).headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("ms_not_configured");
    expect(location.searchParams.get("next")).toBe(DEEP);
  });

  it("SSO, when the org has none", async () => {
    h.org = null;
    const location = new URL((await starts[2][1](`?next=${encodeURIComponent(DEEP)}`)).headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("sso_not_configured");
    expect(location.searchParams.get("next")).toBe(DEEP);
  });

  it("Google, when the visitor is starting too often", async () => {
    // Same client address every time, so the per-address limit (15) runs out.
    const fixed = () => new NextRequest(`http://localhost:3000/api/auth/google?next=${encodeURIComponent(DEEP)}`, {
      headers: { host: "localhost:3000", "x-forwarded-for": "203.0.113.77" },
    });
    let location = new URL("http://localhost:3000/");
    for (let i = 0; i < 20 && location.pathname !== "/login"; i++) {
      location = new URL((await googleStart(fixed())).headers.get("location")!);
    }
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("rate_limited");
    expect(location.searchParams.get("next")).toBe(DEEP);
  });
});
