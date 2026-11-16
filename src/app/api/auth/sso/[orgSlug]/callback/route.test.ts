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
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { OrgRole, type IdpConnection } from "@prisma/client";

const { findUnique, completeSsoLogin } = vi.hoisted(() => ({ findUnique: vi.fn(), completeSsoLogin: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { organization: { findUnique } }, prismaUnfiltered: {} }));
// The security core has its own tests; here only where the callback sends the browser after it.
vi.mock("@/lib/auth/sso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/sso")>()),
  completeSsoLogin,
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/chat/seed-general", () => ({ autoJoinGeneral: vi.fn() }));

import { GET } from "./route";
import { clearOidcConfigCache } from "@/lib/auth/sso";
import { sealSecret } from "@/lib/crypto/vault";
import { FAKE_IDP_CLIENT_ID, FAKE_IDP_NONCE, startFakeIdp, type FakeIdp } from "@/lib/auth/__tests__/fake-idp";
import { RETURN_TO_COOKIE } from "@/lib/auth/return-to";
import { SESSION_COOKIE } from "@/lib/auth/client";

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
function callback(extraCookie = "") {
  const req = new NextRequest(`http://localhost:3000/api/auth/sso/acme/callback?code=${CODE}&state=${TX.state}`, {
    headers: {
      cookie: `sso_tx=${encodeURIComponent(JSON.stringify(TX))}${extraCookie}`,
      "x-forwarded-for": `198.51.100.${crypto.randomInt(1, 250)}`,
    },
  });
  return GET(req, { params: Promise.resolve({ orgSlug: "acme" }) });
}

/** Everything the callback logged with console.error, as the console prints it. */
async function loggedBy<R>(run: () => Promise<R>) {
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

describe("SSO callback: where a sign-in lands", () => {
  const kept = (path: string) => `; ${RETURN_TO_COOKIE}=${encodeURIComponent(path)}`;
  const landed = (res: Response) => {
    const url = new URL(res.headers.get("location")!);
    return `${url.pathname}${url.search}`;
  };

  beforeEach(() => {
    completeSsoLogin.mockResolvedValue({ ok: true, token: "session-token", userId: "u1", mfaSatisfied: true });
  });

  it("lands on the page kept at the start when it is in this org, and clears it", async () => {
    const res = await callback(kept("/acme/issues?view=list"));
    // Positive control: the code exchange went through and a session was set.
    expect(completeSsoLogin).toHaveBeenCalledTimes(1);
    expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=session-token`);
    expect(landed(res)).toBe("/acme/issues?view=list");
    expect(res.headers.get("set-cookie")).toMatch(/signin_return=;/);
  });

  it.each([
    ["a page in another org", "/other/issues"],
    ["an org whose name starts the same", "/acme-other/issues"],
    ["an address that is not a page on this site", "//elsewhere.example/acme"],
  ])("lands on the org's home for %s: the session opens this org only", async (_case, path) => {
    const res = await callback(kept(path));
    expect(completeSsoLogin).toHaveBeenCalledTimes(1);
    expect(landed(res)).toBe("/acme");
  });

  it("lands on the org's home with nothing kept", async () => {
    expect(landed(await callback())).toBe("/acme");
  });

  it("sends a failure it didn't expect to the sign-in page, clears the cookie, and logs no address", async () => {
    completeSsoLogin.mockRejectedValueOnce(
      Object.assign(new Error("account write failed for person@sso.test"), { code: "P1001" }),
    );
    const { res, lines, text } = await loggedBy(() => callback(kept("/acme/issues")));
    expect(completeSsoLogin).toHaveBeenCalledTimes(1);
    const url = new URL(res.headers.get("location")!);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("auth_failed");
    expect(url.searchParams.get("next")).toBe("/acme/issues");
    expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
    expect(res.cookies.get(RETURN_TO_COOKIE)?.expires).toEqual(new Date(0));
    expect(res.cookies.get("sso_tx")?.value).toBe("");
    expect(lines).toContain(format("[sso] sign-in failed", { name: "Error", code: "P1001" }));
    expect(text).not.toContain("person@sso.test");
  });

  it("lets Next's own redirect through, rather than reporting it as a failure", async () => {
    completeSsoLogin.mockImplementationOnce(async () => redirect("/elsewhere"));
    const { res: thrown, lines } = await loggedBy(() =>
      callback(kept("/acme/issues")).then(
        () => null,
        (err: unknown) => err,
      ),
    );
    expect(completeSsoLogin).toHaveBeenCalledTimes(1);
    expect(isRedirectError(thrown)).toBe(true);
    expect(isRedirectError(thrown) && getURLFromRedirectError(thrown)).toBe("/elsewhere");
    expect(lines.filter((line) => line.includes("sign-in failed"))).toEqual([]);
  });

  it("keeps the page on the sign-in page when the sign-in is refused, and clears the cookie", async () => {
    completeSsoLogin.mockResolvedValue({ ok: false, reason: "jit_disabled" });
    const res = await callback(kept("/acme/issues"));
    const url = new URL(res.headers.get("location")!);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("sso_no_account");
    expect(url.searchParams.get("next")).toBe("/acme/issues");
    // The address travels in the link now; the cookie is spent either way.
    expect(res.cookies.get(RETURN_TO_COOKIE)?.value).toBe("");
    expect(res.cookies.get(RETURN_TO_COOKIE)?.expires).toEqual(new Date(0));
  });
});
