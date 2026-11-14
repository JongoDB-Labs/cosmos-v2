// @vitest-environment node
//
// Where the SSO relying party may connect. Every request openid-client makes for
// an org's connection (discovery, then the token endpoint and any other the
// discovery document names) is held to the same outbound-address guard as every
// other URL Cosmos is told to call (security/outbound-post.server.ts): never
// link-local or cloud metadata, and a private address only inside the ranges
// the operator lists for identity providers, SSO_ALLOW_PRIVATE_CIDRS. That list
// is SSO's alone: OUTBOUND_ALLOW_PRIVATE_CIDRS, the org-admin endpoints' list,
// never opens an issuer. Operators do run identity providers on private
// networks, so the allowed path is tested end to end too.
//
// And when a sign-in fails, the log line says why (the cause chain) without
// what openid-client attaches to its errors: the token response and the
// callback's parameters.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import * as oidc from "openid-client";
import { OrgRole, type IdpConnection } from "@prisma/client";

vi.mock("@/lib/db/client", () => ({ prisma: {}, prismaUnfiltered: {} }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/chat/seed-general", () => ({ autoJoinGeneral: vi.fn() }));

import { clearOidcConfigCache, describeSsoError, getOidcConfig } from "./sso";
import { sealSecret } from "@/lib/crypto/vault";
import { OutboundRefused } from "@/lib/security/outbound-post.server";
import { FAKE_IDP_CLIENT_ID, FAKE_IDP_NONCE, startFakeIdp, type FakeIdp } from "./__tests__/fake-idp";

const SSO_ENV = "SSO_ALLOW_PRIVATE_CIDRS";
const ORG_ADMIN_ENV = "OUTBOUND_ALLOW_PRIVATE_CIDRS";
const CLIENT_SECRET = "test-client-secret-7f3a";

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp();
});
afterAll(() => idp.close());

beforeEach(() => {
  idp.reset();
  clearOidcConfigCache();
  vi.stubEnv("SSO_ALLOW_INSECURE_ISSUER", "1");
  vi.stubEnv("SSO_VAULT_KEYS", "");
  vi.stubEnv("SSO_VAULT_KEY", crypto.randomBytes(32).toString("base64"));
  // Neither list carries anything unless a test says so, whatever this
  // machine's environment holds.
  vi.stubEnv(SSO_ENV, "");
  vi.stubEnv(ORG_ADMIN_ENV, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function conn(issuerUrl: string): IdpConnection {
  return {
    id: "00000000-0000-0000-0000-0000000000bb",
    orgId: "00000000-0000-0000-0000-0000000000aa",
    protocol: "OIDC",
    issuerUrl,
    clientId: FAKE_IDP_CLIENT_ID,
    clientSecretEnc: sealSecret(CLIENT_SECRET),
    scopes: ["openid", "email", "profile"],
    attributeMapping: {},
    roleMapping: {},
    jitProvisioning: true,
    defaultRole: OrgRole.MEMBER,
    requiredAcr: null,
    enabled: true,
    enforced: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IdpConnection;
}

/** What `p` rejected with, or null if it resolved. */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return null;
}

/** The guard's refusal behind whatever openid-client wrapped it in, or null. */
async function refusalOf(p: Promise<unknown>): Promise<OutboundRefused | null> {
  const err = await rejectionOf(p);
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof OutboundRefused) return e;
  }
  if (err) throw err;
  return null;
}

/** The IdP's redirect back to Cosmos, as the callback route rebuilds it. */
const CODE = "the-code-7f3a";
const callbackUrl = () => new URL(`https://cosmos.example/api/auth/sso/acme/callback?code=${CODE}&state=test-state`);
const checks = { pkceCodeVerifier: "v".repeat(43), expectedState: "test-state", expectedNonce: FAKE_IDP_NONCE, idTokenExpected: true };

describe("SSO discovery and token requests go through the outbound-address guard", () => {
  it("refuses an issuer at a private address no list holds, without connecting", async () => {
    const refused = await refusalOf(getOidcConfig(conn(idp.issuer)));
    expect(refused).toBeInstanceOf(OutboundRefused);
    expect(refused!.message).toMatch(/isn't public/);
    expect(idp.hits.discovery).toBe(0);
  });

  it("refuses an issuer whose range is only in the org-admin list, OUTBOUND_ALLOW_PRIVATE_CIDRS", async () => {
    vi.stubEnv(ORG_ADMIN_ENV, "127.0.0.0/8");
    const refused = await refusalOf(getOidcConfig(conn(idp.issuer)));
    expect(refused).toBeInstanceOf(OutboundRefused);
    expect(idp.hits.discovery).toBe(0);
  });

  it("reaches an issuer in SSO_ALLOW_PRIVATE_CIDRS, through discovery and the code exchange", async () => {
    vi.stubEnv(SSO_ENV, "127.0.0.0/8");
    const config = await getOidcConfig(conn(idp.issuer));
    expect(idp.hits.discovery).toBe(1);

    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl(), checks);
    expect(tokens.claims()?.sub).toBe("idp-subject-1");
    expect(idp.hits.token).toBe(1);
    // The form openid-client built arrived intact through the guard.
    expect(idp.tokenRequest?.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(idp.tokenRequest?.body.get("grant_type")).toBe("authorization_code");
    expect(idp.tokenRequest?.body.get("code")).toBe(CODE);
    expect(idp.tokenRequest?.body.get("client_id")).toBe(FAKE_IDP_CLIENT_ID);
    expect(idp.tokenRequest?.body.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("holds the code exchange to the guard too, not only discovery", async () => {
    vi.stubEnv(SSO_ENV, "127.0.0.0/8");
    const config = await getOidcConfig(conn(idp.issuer));
    expect(idp.hits.discovery).toBe(1);

    // The same token endpoint, once its address is no longer allowed.
    vi.stubEnv(SSO_ENV, "");
    const refused = await refusalOf(oidc.authorizationCodeGrant(config, callbackUrl(), checks));
    expect(refused).toBeInstanceOf(OutboundRefused);
    expect(refused!.message).toMatch(/isn't public/);
    expect(idp.hits.token).toBe(0);
  });

  it("never reaches a link-local or metadata issuer, whatever either list holds", async () => {
    vi.stubEnv(SSO_ENV, "0.0.0.0/0,::/0");
    vi.stubEnv(ORG_ADMIN_ENV, "0.0.0.0/0,::/0");
    for (const url of ["http://169.254.169.254/", "http://metadata.google.internal/"]) {
      clearOidcConfigCache();
      expect(await refusalOf(getOidcConfig(conn(url)))).toBeInstanceOf(OutboundRefused);
    }
  });
});

describe("describeSsoError: the cause chain for a log line, and nothing an error carries", () => {
  const logged = (err: unknown) => JSON.stringify(describeSsoError(err));
  /** What the chain carries besides Errors: the payloads openid-client attaches. */
  const carried = (err: unknown) => {
    const out: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      if (e.cause !== undefined && !(e.cause instanceof Error)) out.push(JSON.stringify(e.cause));
    }
    return out.join("\n");
  };

  it("names the guard's refusal behind openid-client's wrapper", async () => {
    vi.stubEnv(SSO_ENV, "127.0.0.0/8");
    // The discovery document names a token endpoint outside the list.
    idp.tokenEndpoint = "http://10.255.255.1/token";
    const config = await getOidcConfig(conn(idp.issuer));
    const err = await rejectionOf(oidc.authorizationCodeGrant(config, callbackUrl(), checks));
    expect(err).toBeInstanceOf(Error);
    const chain = describeSsoError(err);
    expect(chain.map((e) => e.name)).toContain("OutboundRefused");
    expect(chain.find((e) => e.name === "OutboundRefused")?.message).toMatch(/isn't public/);
    expect(logged(err)).not.toContain(CODE);
    expect(logged(err)).not.toContain(CLIENT_SECRET);
  });

  it("leaves out the error body the token endpoint sent", async () => {
    vi.stubEnv(SSO_ENV, "127.0.0.1/32");
    idp.tokenError = { status: 400, body: { error: "invalid_grant", error_description: "idp-detail-7f3a" } };
    const config = await getOidcConfig(conn(idp.issuer));
    const err = await rejectionOf(oidc.authorizationCodeGrant(config, callbackUrl(), checks));
    expect(err).toBeInstanceOf(Error);
    // Positive control: the error itself does carry the body.
    expect(carried(err)).toContain("idp-detail-7f3a");
    expect(describeSsoError(err).length).toBeGreaterThan(0);
    expect(logged(err)).not.toContain("idp-detail-7f3a");
  });

  it("leaves out the ID token's claims when the ID token is refused", async () => {
    vi.stubEnv(SSO_ENV, "127.0.0.1/32");
    const config = await getOidcConfig(conn(idp.issuer));
    // A nonce mismatch: the token response arrived, and its ID token is refused.
    const err = await rejectionOf(oidc.authorizationCodeGrant(config, callbackUrl(), { ...checks, expectedNonce: "another-nonce" }));
    expect(err).toBeInstanceOf(Error);
    expect(idp.hits.token).toBe(1);
    // Positive control: the error carries the token's claims.
    expect(carried(err)).toContain("idp-subject-1");
    expect(describeSsoError(err).length).toBeGreaterThan(0);
    expect(logged(err)).not.toContain("idp-subject-1");
  });

  it("leaves out the token response when it is refused", async () => {
    vi.stubEnv(SSO_ENV, "127.0.0.1/32");
    idp.tokenExtra = { token_type: "unheard-of", access_token: "access-7f3a" };
    const config = await getOidcConfig(conn(idp.issuer));
    const err = await rejectionOf(oidc.authorizationCodeGrant(config, callbackUrl(), checks));
    expect(err).toBeInstanceOf(Error);
    // Positive control: the error carries the whole response, tokens and all.
    expect(carried(err)).toContain("access-7f3a");
    expect(carried(err)).toContain("id_token");
    expect(describeSsoError(err).length).toBeGreaterThan(0);
    expect(logged(err)).not.toContain("access-7f3a");
    expect(logged(err)).not.toContain("id_token");
  });

  it("cuts the query string off any URL in a message", () => {
    const err = new Error("request to https://cosmos.example/api/auth/sso/acme/callback?code=abc123&state=xyz failed", {
      cause: new Error("see http://idp.example/token?code=def456"),
    });
    const text = logged(err);
    expect(text).toContain("https://cosmos.example/api/auth/sso/acme/callback");
    expect(text).not.toMatch(/abc123|def456|state=xyz/);
  });

  it("logs nothing of a thrown non-Error", () => {
    expect(logged("code=abc123")).not.toContain("abc123");
  });
});
