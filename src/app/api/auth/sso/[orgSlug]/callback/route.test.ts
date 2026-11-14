// @vitest-environment node
//
// When the code exchange fails, the callback logs why, cause and all, so an
// operator can tell a refused address from a bad token. And it logs nothing an
// openid-client error carries besides that: not the token response, not the
// authorization code, not the client secret.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { format } from "node:util";
import { NextRequest } from "next/server";
import { OrgRole, type IdpConnection } from "@prisma/client";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique } }, prismaUnfiltered: {} }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/chat/seed-general", () => ({ autoJoinGeneral: vi.fn() }));

import { GET } from "./route";
import { clearOidcConfigCache } from "@/lib/auth/sso";
import { sealSecret } from "@/lib/crypto/vault";
import { FAKE_IDP_CLIENT_ID, FAKE_IDP_NONCE, startFakeIdp, type FakeIdp } from "@/lib/auth/__tests__/fake-idp";

const CODE = "the-code-7f3a";
const CLIENT_SECRET = "test-client-secret-7f3a";
const TX = { orgSlug: "acme", state: "test-state", nonce: FAKE_IDP_NONCE, codeVerifier: "v".repeat(43) };

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
  vi.stubEnv("SSO_ALLOW_PRIVATE_CIDRS", "127.0.0.1/32");
  vi.stubEnv("OUTBOUND_ALLOW_PRIVATE_CIDRS", "");
  findUnique.mockResolvedValue({
    idpConnection: {
      id: "00000000-0000-0000-0000-0000000000bb",
      orgId: "00000000-0000-0000-0000-0000000000aa",
      protocol: "OIDC",
      issuerUrl: idp.issuer,
      clientId: FAKE_IDP_CLIENT_ID,
      clientSecretEnc: sealSecret(CLIENT_SECRET),
      scopes: ["openid"],
      attributeMapping: {},
      roleMapping: {},
      jitProvisioning: true,
      defaultRole: OrgRole.MEMBER,
      requiredAcr: null,
      enabled: true,
      enforced: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies IdpConnection,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The callback as the IdP's redirect reaches it, from a fresh client address each time. */
function callback() {
  const req = new NextRequest(`http://localhost:3000/api/auth/sso/acme/callback?code=${CODE}&state=${TX.state}`, {
    headers: { cookie: `sso_tx=${encodeURIComponent(JSON.stringify(TX))}`, "x-forwarded-for": `198.51.100.${crypto.randomInt(1, 250)}` },
  });
  return GET(req, { params: Promise.resolve({ orgSlug: "acme" }) });
}

/** Everything the callback logged with console.error, as the console prints it. */
async function loggedBy(run: () => Promise<Response>) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await run();
  const lines = spy.mock.calls.map((args) => format(...args));
  return { res, lines, text: lines.join("\n") };
}

describe("SSO callback: what a failed code exchange logs", () => {
  it("logs the guard's refusal when the token endpoint's address isn't allowed", async () => {
    idp.tokenEndpoint = "http://10.255.255.1/token";
    const { res, lines, text } = await loggedBy(callback);
    expect(res.headers.get("location")).toMatch(/error=auth_failed/);
    expect(lines.filter((l) => l.includes("[sso] code grant / token validation failed"))).toHaveLength(1);
    expect(text).toContain("OutboundRefused");
    expect(text).toMatch(/isn't public/);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(CLIENT_SECRET);
  });

  it("logs why without the body the token endpoint sent", async () => {
    idp.tokenError = { status: 400, body: { error: "invalid_grant", error_description: "idp-detail-7f3a" } };
    const { res, lines, text } = await loggedBy(callback);
    expect(res.headers.get("location")).toMatch(/error=auth_failed/);
    expect(idp.hits.token).toBe(1);
    expect(lines.filter((l) => l.includes("[sso] code grant / token validation failed"))).toHaveLength(1);
    expect(text).not.toContain("idp-detail-7f3a");
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(CLIENT_SECRET);
  });
});
