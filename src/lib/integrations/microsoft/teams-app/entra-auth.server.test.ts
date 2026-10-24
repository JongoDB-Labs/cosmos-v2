// COSMOS-202 T1 d: the Teams SSO token check, rule by rule: each test breaks
// one part of a good token.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { fakeEntra } from "@/lib/testing/fake-entra";
import { EntraAuthError, _resetEntraKeys, tabAppIdUri, verifyTabToken } from "./entra-auth.server";

const TID = "11111111-2222-3333-4444-555555555555";
const APP = "00000000-aaaa-bbbb-cccc-000000000001";
const URI = tabAppIdUri("https://cosmos.example", APP);

describe("verifyTabToken", () => {
  let e: ReturnType<typeof fakeEntra>;
  let now: number;
  const deps = () => ({ fetch: e.fetch, now: () => now });
  const good = (claims: object = {}, o: Parameters<typeof e.token>[1] = {}) => e.token({ aud: URI, ...claims }, { nowS: Math.floor(now / 1000), ...o });
  const reason = async (t: string, tid = TID, uri: string | (() => Promise<string | null>) = URI) => {
    try {
      const id = await verifyTabToken(t, tid, uri, deps());
      return `ok:${id.oid}`;
    } catch (err) {
      if (err instanceof EntraAuthError) return err.reason;
      throw err;
    }
  };

  beforeEach(() => {
    _resetEntraKeys();
    e = fakeEntra({ tid: TID });
    now = Date.parse("2026-10-24T03:00:00Z");
  });

  it("accepts a Teams SSO token for our App ID URI from the org's tenant, v2 or v1 issuer", async () => {
    expect(URI).toBe(`api://cosmos.example/${APP}`);
    expect(await reason(good())).toBe("ok:oid-1");
    expect(await reason(good({ iss: `https://sts.windows.net/${TID}/` }))).toBe("ok:oid-1");
  });

  it("refuses another tenant's token before fetching anything", async () => {
    expect(await reason(good({ tid: "99999999-0000-0000-0000-000000000000" }))).toBe("wrong_tenant");
    expect(await reason(good(), "not-a-guid")).toBe("wrong_tenant");
    expect(e.state.metadataFetches).toBe(0);
  });

  it("only RS256, signed by the tenant's key", async () => {
    expect(await reason(good({}, { alg: "none" }))).toBe("bad_alg");
    expect(await reason(good({}, { alg: "HS256" }))).toBe("bad_alg");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(await reason(good({}, { key: privateKey }))).toBe("bad_signature");
    expect(await reason("a.b")).toBe("malformed");
  });

  it("checks issuer, audience, scope and oid", async () => {
    expect(await reason(good({ iss: "https://login.microsoftonline.com/common/v2.0" }))).toBe("bad_issuer");
    expect(await reason(good({ iss: `https://sts.windows.net/99999999-0000-0000-0000-000000000000/` }))).toBe("bad_issuer");
    expect(await reason(good({ aud: APP }))).toBe("bad_audience"); // the bare app id is not the App ID URI
    expect(await reason(good({ aud: "api://evil.example/" + APP }))).toBe("bad_audience");
    expect(await reason(good({ scp: "User.Read" }))).toBe("bad_scope");
    expect(await reason(good({ scp: undefined }))).toBe("bad_scope");
    expect(await reason(good({ oid: undefined }))).toBe("no_oid");
  });

  it("only from Microsoft Teams as the client app (azp in v2, appid in v1)", async () => {
    expect(await reason(good({ azp: "5e3ce6c0-2b1f-4285-8d4b-75ee78787346" }))).toBe("ok:oid-1"); // Teams web
    expect(await reason(good({ azp: undefined, appid: "1fec8e78-bce4-4aaf-ab1b-5451cc387264", iss: `https://sts.windows.net/${TID}/` }))).toBe("ok:oid-1");
    // Another app the user consented to in the same tenant.
    expect(await reason(good({ azp: "22222222-3333-4444-5555-666666666666" }))).toBe("not_teams_client");
    expect(await reason(good({ azp: undefined }))).toBe("not_teams_client");
    expect(await reason(good({ azp: undefined, appid: "22222222-3333-4444-5555-666666666666" }))).toBe("not_teams_client");
  });

  it("allows five minutes of clock skew, no more", async () => {
    const t = Math.floor(now / 1000);
    expect(await reason(good({ exp: t - 299 }))).toBe("ok:oid-1");
    expect(await reason(good({ exp: t - 301 }))).toBe("expired");
    expect(await reason(good({ nbf: t + 301 }))).toBe("not_yet_valid");
  });

  it("never follows a redirect when fetching metadata or keys", async () => {
    expect(await reason(good())).toBe("ok:oid-1");
    expect(e.state.redirects).toEqual(["error", "error"]);
  });

  it("takes the key set only from the Microsoft login host the metadata is on", async () => {
    e = fakeEntra({ tid: TID, jwksOrigin: "https://evil.example" });
    expect(await reason(good())).toBe("bad_metadata");
  });

  it("caches keys, refetches on rotation, isn't made to refetch by made-up key ids, and fails closed after 48h without a refresh", async () => {
    expect(await reason(good())).toBe("ok:oid-1");
    expect(await reason(good())).toBe("ok:oid-1");
    expect(e.state.fetches).toBe(1);
    now += 6 * 60_000;
    e.rotate("e2");
    expect(await reason(good({}, { kid: "e2" }))).toBe("ok:oid-1");
    for (let i = 0; i < 4; i++) expect(await reason(good({}, { kid: `made-up-${i}` }))).toBe("unknown_key");
    expect(e.state.fetches).toBe(2);
    e.state.down = true;
    now += 47 * 3600_000;
    expect(await reason(good({}, { kid: "e2" }))).toBe("ok:oid-1");
    now += 2 * 3600_000;
    expect(await reason(good({}, { kid: "e2" }))).toBe("keys_expired");
  });

  it("works out the App ID URI only after the signature and claims check out", async () => {
    const lookup = vi.fn(async () => URI);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    for (const bad of [good({}, { key: privateKey }), good({ iss: "x" }), good({ scp: "x" }), good({ exp: 1 })]) await reason(bad, TID, lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(await reason(good(), TID, lookup)).toBe("ok:oid-1");
    expect(await reason(good(), TID, async () => null)).toBe("not_configured");
  });
});
