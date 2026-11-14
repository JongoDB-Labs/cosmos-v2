// @vitest-environment node
//
// Where the SSO relying party may connect. Every request openid-client makes for
// an org's connection (discovery, then the token endpoint and any other the
// discovery document names) is held to the same outbound-address guard as every
// other URL Cosmos is told to call (security/outbound-post.server.ts): a private
// address only inside the operator's OUTBOUND_ALLOW_PRIVATE_CIDRS, link-local
// and cloud metadata never. Operators do run identity providers on private
// networks, so the allowed path is tested end to end too.
//
// The IdP is a real HTTP server on 127.0.0.1, which is a private address like
// any other: reaching it needs 127.0.0.0/8 in the operator's list. It is plain
// http, so SSO_ALLOW_INSECURE_ISSUER is on throughout; that switch says nothing
// about which addresses may be reached.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as oidc from "openid-client";
import { OrgRole, type IdpConnection } from "@prisma/client";

vi.mock("@/lib/db/client", () => ({ prisma: {}, prismaUnfiltered: {} }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/chat/seed-general", () => ({ autoJoinGeneral: vi.fn() }));

import { clearOidcConfigCache, getOidcConfig } from "./sso";
import { sealSecret } from "@/lib/crypto/vault";
import { OutboundRefused } from "@/lib/security/outbound-post.server";

const ENV = "OUTBOUND_ALLOW_PRIVATE_CIDRS";
const CLIENT_ID = "cosmos-test-client";
const CLIENT_SECRET = "test-client-secret";

let server: http.Server;
let issuer = "";
const hits = { discovery: 0, token: 0 };
let tokenRequest: { contentType: string; body: URLSearchParams } | null = null;

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/openid-configuration") {
      hits.discovery++;
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/token") {
      hits.token++;
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (raw += c));
      req.on("end", () => {
        tokenRequest = { contentType: String(req.headers["content-type"] ?? ""), body: new URLSearchParams(raw) };
        const now = Math.floor(Date.now() / 1000);
        // Signature bytes are never checked for a token-endpoint ID token: TLS
        // stands in for it (OpenID Connect Core 3.1.3.7), and openid-client only
        // fetches the JWKS when non-repudiation checks are enabled.
        const idToken = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({
          iss: issuer,
          aud: CLIENT_ID,
          sub: "idp-subject-1",
          nonce: "test-nonce",
          iat: now,
          exp: now + 300,
        })}.c2lnbmF0dXJl`;
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  hits.discovery = 0;
  hits.token = 0;
  tokenRequest = null;
  clearOidcConfigCache();
  vi.stubEnv("SSO_ALLOW_INSECURE_ISSUER", "1");
  vi.stubEnv("SSO_VAULT_KEYS", "");
  vi.stubEnv("SSO_VAULT_KEY", crypto.randomBytes(32).toString("base64"));
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
    clientId: CLIENT_ID,
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

/** The guard's refusal behind whatever openid-client wrapped it in, or null. */
async function refusalOf(p: Promise<unknown>): Promise<OutboundRefused | null> {
  try {
    await p;
  } catch (err) {
    for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
      if (e instanceof OutboundRefused) return e;
    }
    throw err;
  }
  return null;
}

/** The IdP's redirect back to Cosmos, as the callback route rebuilds it. */
const callbackUrl = () => new URL("https://cosmos.example/api/auth/sso/acme/callback?code=the-code&state=test-state");
const checks = { pkceCodeVerifier: "v".repeat(43), expectedState: "test-state", expectedNonce: "test-nonce", idTokenExpected: true };

describe("SSO discovery and token requests go through the outbound-address guard", () => {
  it("refuses an issuer at a private address the operator hasn't listed, without connecting", async () => {
    vi.stubEnv(ENV, "");
    const refused = await refusalOf(getOidcConfig(conn(issuer)));
    expect(refused).toBeInstanceOf(OutboundRefused);
    expect(refused!.message).toMatch(/isn't public/);
    expect(hits.discovery).toBe(0);
  });

  it("reaches an issuer on a private network the operator lists, through discovery and the code exchange", async () => {
    vi.stubEnv(ENV, "127.0.0.0/8");
    const config = await getOidcConfig(conn(issuer));
    expect(hits.discovery).toBe(1);

    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl(), checks);
    expect(tokens.claims()?.sub).toBe("idp-subject-1");
    expect(hits.token).toBe(1);
    // The form openid-client built arrived intact through the guard.
    expect(tokenRequest?.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(tokenRequest?.body.get("grant_type")).toBe("authorization_code");
    expect(tokenRequest?.body.get("code")).toBe("the-code");
    expect(tokenRequest?.body.get("client_id")).toBe(CLIENT_ID);
    expect(tokenRequest?.body.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("holds the code exchange to the guard too, not only discovery", async () => {
    vi.stubEnv(ENV, "127.0.0.0/8");
    const config = await getOidcConfig(conn(issuer));
    expect(hits.discovery).toBe(1);

    // The same token endpoint, once its address is no longer allowed.
    vi.stubEnv(ENV, "");
    const refused = await refusalOf(oidc.authorizationCodeGrant(config, callbackUrl(), checks));
    expect(refused).toBeInstanceOf(OutboundRefused);
    expect(refused!.message).toMatch(/isn't public/);
    expect(hits.token).toBe(0);
  });

  it("never reaches a link-local or metadata issuer, whatever the operator lists", async () => {
    vi.stubEnv(ENV, "0.0.0.0/0,::/0");
    for (const url of ["http://169.254.169.254/", "http://metadata.google.internal/"]) {
      clearOidcConfigCache();
      expect(await refusalOf(getOidcConfig(conn(url)))).toBeInstanceOf(OutboundRefused);
    }
  });
});
