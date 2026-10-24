// COSMOS-202 T1 d: a Teams tab signs in. Only a fully verified SSO token from a
// tenant with the app on gets a tab session; nothing reaches the database or
// fetches keys for anyone else, and the token never reaches a log.
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { fakeEntra } from "@/lib/testing/fake-entra";

const TID = "11111111-2222-3333-4444-555555555555";
const APP = "00000000-aaaa-bbbb-cccc-000000000001";
const URI = `api://cosmos.example/${APP}`;
const m = vi.hoisted(() => ({
  appIdLookups: 0,
  users: [] as { orgId: string; slug: string; userId: string }[],
  orgs: [] as { orgId: string; slug: string }[],
}));

vi.mock("@/lib/integrations/microsoft/teams-app/identity.server", () => ({
  teamsAppTenants: async () => new Set([TID]),
  teamsBotAppId: async () => {
    m.appIdLookups++;
    return APP;
  },
  teamsOrgsForTenant: async () => m.orgs,
  teamsUsers: async () => m.users,
}));

import { POST } from "./route";
import { _resetEntraKeys } from "@/lib/integrations/microsoft/teams-app/entra-auth.server";

const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
beforeAll(() => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
});
afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

let e: ReturnType<typeof fakeEntra>;
let ipN = 0;
const req = (body: unknown, ip = `10.3.0.${++ipN}`) =>
  new NextRequest("http://localhost:3000/api/teams/tab/session", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "x-forwarded-host": "cosmos.example", "x-forwarded-proto": "https" },
  });
const alice = { orgId: "org-1", slug: "acme", userId: "u-1" };

describe("POST /api/teams/tab/session", () => {
  beforeEach(() => {
    _resetEntraKeys();
    process.env.COSMOS_PUBLIC_URL = "https://cosmos.example";
    e = fakeEntra({ tid: TID });
    vi.stubGlobal("fetch", e.fetch);
    m.appIdLookups = 0;
    m.orgs = [{ orgId: "org-1", slug: "acme" }];
    m.users = [alice];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COSMOS_PUBLIC_URL;
  });

  it("a good token starts an hour's tab session for that person, in a partitioned cookie scoped to the tab", async () => {
    const res = await POST(req({ token: e.token({ aud: URI }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ org: "acme" });
    const c = res.headers.get("set-cookie")!;
    expect(c).toMatch(/^teams_tab=v\d\.[^;]+; Path=\/teams\/tab; Max-Age=3600; HttpOnly; Secure; SameSite=None; Partitioned$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("another tenant's token is refused with no key fetch and no database read", async () => {
    const res = await POST(req({ token: e.token({ aud: URI, tid: "99999999-0000-0000-0000-000000000000" }) }));
    expect(res.status).toBe(401);
    expect(e.state.metadataFetches).toBe(0);
    expect(m.appIdLookups).toBe(0);
  });

  it("forged, for another app, or without the scope: 401, no cookie, and the app id isn't even looked up for a bad signature", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = await POST(req({ token: e.token({ aud: URI }, { key: privateKey }) }));
    expect(forged.status).toBe(401);
    expect(m.appIdLookups).toBe(0);
    for (const token of [e.token({ aud: `api://cosmos.example/other` }), e.token({ aud: URI, scp: "User.Read" }), "", "x.y.z"]) {
      const res = await POST(req({ token }));
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("someone Cosmos can't match gets told how to connect, and no session", async () => {
    m.users = [];
    const res = await POST(req({ token: e.token({ aud: URI }) }));
    expect(res.status).toBe(403);
    // The front door, not the org: no org slug to someone Cosmos can't match.
    expect(await res.json()).toEqual({ error: "not_connected", connectUrl: "https://cosmos.example/" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("with accounts in two orgs, asks which, then signs in to the one asked for (and only one they have)", async () => {
    m.users = [alice, { orgId: "org-2", slug: "beta", userId: "u-1" }];
    const ask = await POST(req({ token: e.token({ aud: URI }) }));
    expect(ask.status).toBe(409);
    expect(await ask.json()).toEqual({ error: "choose_org", orgs: ["acme", "beta"] });
    const beta = await POST(req({ token: e.token({ aud: URI }), org: "beta" }));
    expect(await beta.json()).toEqual({ org: "beta" });
    expect((await POST(req({ token: e.token({ aud: URI }), org: "gamma" }))).status).toBe(409);
  });

  it("expects our App ID URI from the configured public URL, whatever Host the request claims", async () => {
    const forged = new NextRequest("http://localhost:3000/api/teams/tab/session", {
      method: "POST", body: JSON.stringify({ token: e.token({ aud: `api://evil.example/${APP}` }) }),
      headers: { "x-forwarded-for": `10.4.0.${++ipN}`, "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    });
    expect((await POST(forged)).status).toBe(401);
    delete process.env.COSMOS_PUBLIC_URL;
    expect((await POST(req({ token: e.token({ aud: URI }) }))).status).toBe(503); // not configured: no tab sign-in at all
  });

  it("caps the body, rejects non-JSON, and never logs the token", async () => {
    expect((await POST(req("x".repeat(20 * 1024)))).status).toBe(413);
    expect((await POST(req("{nope"))).status).toBe(400);
    const t = e.token({ aud: "api://elsewhere/x" });
    await POST(req({ token: t }));
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).toContain("bad_audience");
    expect(logged).not.toContain(t.slice(0, 30));
  });

  it("rate limits each IP before anything else", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 33; i++) statuses.push((await POST(req({ token: "" }, "10.9.9.8"))).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
  });
});
