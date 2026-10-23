// COSMOS-202 (B1): the connect round trip's state and URLs.
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { calendarAdminConsentUrl, calendarAuthorizeUrl, idTokenClaims, newConnectState, openConnectState } from "./calendar-connect";

// The real vault, under a throwaway key.
const ORIGINAL_VAULT_KEY = process.env.SSO_VAULT_KEY;
beforeAll(() => {
  process.env.SSO_VAULT_KEY = crypto.randomBytes(32).toString("base64");
});
afterAll(() => {
  if (ORIGINAL_VAULT_KEY === undefined) delete process.env.SSO_VAULT_KEY;
  else process.env.SSO_VAULT_KEY = ORIGINAL_VAULT_KEY;
});

describe("connect state", () => {
  it("round-trips, and binds the PKCE verifier to its challenge", () => {
    const s = newConnectState("org-1", "user-1", 1_000);
    const open = openConnectState(s.cookie, s.state, 2_000)!;
    expect(open).toMatchObject({ orgId: "org-1", userId: "user-1", state: s.state });
    expect(createHash("sha256").update(open.verifier).digest("base64url")).toBe(s.challenge);
  });

  it("rejects a mismatched state, an expired one, and a tampered cookie", () => {
    const s = newConnectState("org-1", "user-1", 1_000);
    expect(openConnectState(s.cookie, "someone-else", 2_000)).toBeNull();
    expect(openConnectState(s.cookie, s.state, 1_000 + 11 * 60_000)).toBeNull();
    expect(openConnectState(s.cookie.slice(0, -4) + "AAAA", s.state, 2_000)).toBeNull();
    expect(openConnectState(undefined, s.state, 2_000)).toBeNull();
  });
});

describe("URLs", () => {
  it("asks for calendar access only, with PKCE, on the org's tenant", () => {
    const u = new URL(calendarAuthorizeUrl({ clientId: "c", tenantId: "t-1", redirectUri: "https://x/cb", state: "s", challenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/t-1/oauth2/v2.0/authorize");
    expect(u.searchParams.get("scope")).toBe("openid offline_access User.Read Calendars.ReadWrite");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).not.toMatch(/Mail|Files|OnlineMeetings/);
  });

  it("builds the one-time admin consent link for the Graph calendar scopes", () => {
    const u = new URL(calendarAdminConsentUrl({ clientId: "c", tenantId: "t-1", redirectUri: "https://x/cb", orgSlug: "acme" }));
    expect(u.pathname).toBe("/t-1/v2.0/adminconsent");
    expect(u.searchParams.get("scope")).toBe("https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite");
    expect(u.searchParams.get("state")).toBe("admin_consent:acme");
  });
});

describe("idTokenClaims", () => {
  const jwt = (p: object) => `h.${Buffer.from(JSON.stringify(p)).toString("base64url")}.s`;
  it("reads tenant, object id and account name", () => {
    expect(idTokenClaims(jwt({ tid: "t", oid: "o", preferred_username: "a@b" }))).toEqual({ tid: "t", oid: "o", upn: "a@b" });
  });
  it("returns null without a tenant or object id, or for junk", () => {
    expect(idTokenClaims(jwt({ oid: "o" }))).toBeNull();
    expect(idTokenClaims("junk")).toBeNull();
    expect(idTokenClaims(undefined)).toBeNull();
  });
});
