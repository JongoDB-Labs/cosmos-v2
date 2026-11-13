// @vitest-environment node
//
// Microsoft sign-in binds an account to the Entra identity (tenant id + object
// id), not to an email address. Email is used once, to link a first sign-in to
// an existing account (or to create one), and only when it is an address
// Microsoft vouches for:
//   - the `email` claim, only when `xms_edov` marks its domain verified. Pinned
//     tenant or not, `email` on its own is the directory `mail` attribute, which
//     any tenant admin can set to any address;
//   - a MEMBER account's sign-in name (`preferred_username`), only on a domain
//     the operator lists in MICROSOFT_TRUSTED_DOMAINS. Never a guest's, never a
//     personal account's.
// It never links by address onto an account that already has Google, or onto a
// platform admin's address: those connect Microsoft from a signed-in session
// (Profile, Sign-in methods), which binds (tid, oid) without consulting email.
//
// Microsoft is faked at the HTTP boundary (token endpoint, tenant discovery and
// Graph /me), so the real route, the real database and the real session row
// decide every outcome. Each assertion reads the session's USER ID, never the
// email: `User.email` is not unique, so an email assertion cannot tell two
// accounts apart.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { MS_STATE_COOKIE, MSA_TENANT_ID } from "@/lib/auth/microsoft";
import { CONNECT_COOKIE, connectCookieValue } from "@/lib/auth/connect-sign-in";

const h = vi.hoisted(() => ({ tenant: "common" as string | null }));
vi.mock("@/lib/auth/provider-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/provider-config")>()),
  getProviderConfig: async (p: string) =>
    p === "microsoft"
      ? { enabled: true, clientId: "ms-client-id", clientSecret: "ms-secret", tenant: h.tenant }
      : null,
}));

import { GET } from "./route";
import { POST as startConnect } from "../connect/route";

const stamp = Math.random().toString(36).slice(2, 8);
const T_HOME = "11111111-1111-4111-8111-111111111111";
const T_OTHER = "22222222-2222-4222-8222-222222222222";
const T_ATTACKER = "33333333-3333-4333-8333-333333333333";
const oid = (n: number) => `0000000${n}-aaaa-4aaa-8aaa-${stamp}000000`.slice(0, 36);

const victimEmail = `victim-${stamp}@ms-bind.test`;
const migrateEmail = `migrate-${stamp}@ms-bind.test`;
const changedEmail = `renamed-${stamp}@ms-bind.test`;
const edovEmail = `edov-${stamp}@ms-bind.test`;
const domainEmail = `domain-${stamp}@ms-bind.test`;

let victimId = "", migrateId = "", edovId = "", domainId = "";
const createdUserIds: string[] = [];

/** The identity the fake Microsoft returns for the next sign-in. */
type FakeIdentity = {
  tid: string;
  oid: string;
  /** The id_token `email` claim, which Entra fills from the `mail` attribute. */
  email?: string;
  /** Graph's `mail` — tenant-admin-editable and unverified. */
  mail?: string;
  /** `preferred_username` / Graph `userPrincipalName`. */
  upn: string;
  xmsEdov?: boolean;
  /** 0 for a member of the tenant, 1 for a guest. */
  acct?: number;
};
let next: FakeIdentity;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function idToken(id: FakeIdentity): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    aud: "ms-client-id",
    iss: `https://login.microsoftonline.com/${id.tid}/v2.0`,
    iat: now,
    nbf: now,
    exp: now + 3600,
    ver: "2.0",
    tid: id.tid,
    oid: id.oid,
    sub: `pairwise-${id.oid}`,
    preferred_username: id.upn,
    name: "Fake Person",
  };
  if (id.email !== undefined) claims.email = id.email;
  if (id.xmsEdov !== undefined) claims.xms_edov = id.xmsEdov;
  if (id.acct !== undefined) claims.acct = id.acct;
  return `${b64url({ alg: "RS256", typ: "JWT", kid: "k" })}.${b64url(claims)}.c2ln`;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const fakeFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/.test(url)) {
    return json({ access_token: `at-${next.oid}`, id_token: idToken(next), token_type: "Bearer" });
  }
  if (url === "https://graph.microsoft.com/v1.0/me") {
    return json({ id: next.oid, mail: next.mail ?? null, userPrincipalName: next.upn, displayName: "Fake Person" });
  }
  const discovery = url.match(/^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/\.well-known\/openid-configuration$/);
  if (discovery) {
    // Only the configured domain resolves, and it resolves to T_HOME.
    if (discovery[1] === "home.example.com") {
      return json({ issuer: `https://login.microsoftonline.com/${T_HOME}/v2.0` });
    }
    return new Response("not found", { status: 400 });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
});

let ipCounter = 0;
// A fresh client address per call keeps the per-IP limiters out of it.
const nextIp = () => `10.77.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

async function signIn(
  identity: FakeIdentity,
  extraCookie = "",
): Promise<{ userId: string | null; error: string | null; authMethod: string | null; location: URL }> {
  next = identity;
  const req = new NextRequest("http://localhost/api/auth/microsoft/callback?code=c0de&state=st4te", {
    headers: { cookie: `${MS_STATE_COOKIE}=st4te${extraCookie}`, "x-forwarded-for": nextIp() },
  });
  const res = await GET(req);
  const location = new URL(res.headers.get("location") ?? "/", "http://localhost");
  const error = location.searchParams.get("error");
  const sessionId = res.cookies.get(SESSION_COOKIE)?.value;
  if (!sessionId) return { userId: null, error, authMethod: null, location };
  const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, authMethod: true } });
  if (session && !createdUserIds.includes(session.userId)) createdUserIds.push(session.userId);
  return { userId: session?.userId ?? null, error, authMethod: session?.authMethod ?? null, location };
}

async function mkUser(email: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { email, displayName: email.split("@")[0], ...extra } });
  createdUserIds.push(u.id);
  return u.id;
}

async function sessionFor(userId: string, extra: Record<string, unknown> = {}) {
  const id = `ms-test-${stamp}-${Math.random().toString(36).slice(2)}`;
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3_600_000), ...extra } });
  return id;
}

const RETURN_TO = "/acme/settings/profile";

/** Finish a connect round trip for `sessionId` (the session that asked), with
 *  `asSessionId` signed in when the callback returns (default: the same one). */
async function connect(identity: FakeIdentity, sessionId: string, asSessionId = sessionId) {
  const intent = connectCookieValue({ provider: "microsoft", state: "st4te", sessionId, returnTo: RETURN_TO });
  const r = await signIn(identity, `; ${CONNECT_COOKIE}=${intent}; ${SESSION_COOKIE}=${asSessionId}`);
  return {
    ...r,
    connected: r.location.searchParams.get("connected"),
    connectError: r.location.searchParams.get("connect_error"),
  };
}

const boundTo = async (objectId: string, tenantId = T_HOME) =>
  (
    await prisma.microsoftIdentity.findUnique({
      where: { tenantId_objectId: { tenantId, objectId } },
      select: { userId: true },
    })
  )?.userId ?? null;

const usersWithEmail = (email: string) =>
  prisma.user.count({ where: { email: { equals: email, mode: "insensitive" } } });

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubEnv(
    "ALLOWED_EMAILS",
    [victimEmail, migrateEmail, edovEmail, domainEmail].join(","),
  );
  // Accounts that exist before this change: no Microsoft identity bound yet.
  victimId = (await prisma.user.create({ data: { email: victimEmail, displayName: "Victim" } })).id;
  migrateId = (await prisma.user.create({ data: { email: migrateEmail, displayName: "Migrating" } })).id;
  edovId = (await prisma.user.create({ data: { email: edovEmail, displayName: "Edov" } })).id;
  domainId = (await prisma.user.create({ data: { email: domainEmail, displayName: "Domain" } })).id;
  createdUserIds.push(victimId, migrateId, edovId, domainId);
});

beforeEach(() => {
  h.tenant = "common";
  vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "");
  vi.stubEnv("INTERNAL_ADMINS", "");
});

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const strays = await prisma.user.findMany({
    where: { OR: [{ email: { in: [victimEmail, migrateEmail, changedEmail, edovEmail, domainEmail] } }, { email: { contains: stamp } }] },
    select: { id: true },
  });
  const ids = [...new Set([...createdUserIds, ...strays.map((u) => u.id)])];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.microsoftIdentity.deleteMany({ where: { userId: { in: ids } } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("Microsoft sign-in binds the account to (tid, oid)", () => {
  it("refuses a foreign tenant that puts an existing user's address in `mail` (multi-tenant, no xms_edov)", async () => {
    const r = await signIn({
      tid: T_ATTACKER,
      oid: oid(1),
      mail: victimEmail,
      email: victimEmail,
      upn: `someone@attacker-${stamp}.onmicrosoft.com`,
    });
    expect(r.userId).not.toBe(victimId);
    expect(r.userId).toBeNull();
    expect(r.error).toBeTruthy();
    // No second account was minted under the victim's address either.
    expect(await usersWithEmail(victimEmail)).toBe(1);
  });

  it("links an existing account by a member's sign-in name on a trusted domain, then binds (tid, oid)", async () => {
    h.tenant = T_HOME;
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "ms-bind.test");
    const r = await signIn({ tid: T_HOME, oid: oid(2), mail: migrateEmail, upn: migrateEmail, acct: 0 });
    expect(r.error).toBeNull();
    expect(r.userId).toBe(migrateId);
    // The session records how it signed in, which is what system admin reads.
    expect(r.authMethod).toBe("microsoft");
    expect(await boundTo(oid(2))).toBe(migrateId);
  });

  it("matches later sign-ins by (tid, oid) even after the address changes, with no trust configured", async () => {
    h.tenant = T_HOME;
    const r = await signIn({ tid: T_HOME, oid: oid(2), mail: changedEmail, email: changedEmail, upn: changedEmail });
    expect(r.error).toBeNull();
    expect(r.userId).toBe(migrateId);
    expect(await usersWithEmail(changedEmail)).toBe(0);
  });

  it("keeps a bound account out once its address leaves the allowlist", async () => {
    h.tenant = T_HOME;
    vi.stubEnv("ALLOWED_EMAILS", [victimEmail, edovEmail, domainEmail].join(","));
    try {
      const r = await signIn({ tid: T_HOME, oid: oid(2), upn: migrateEmail });
      expect(r.userId).toBeNull();
      expect(r.error).toBe("not_allowed");
    } finally {
      vi.stubEnv("ALLOWED_EMAILS", [victimEmail, migrateEmail, edovEmail, domainEmail].join(","));
    }
  });

  it("does not let a second Microsoft account take over an account that is already bound", async () => {
    h.tenant = T_HOME;
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "ms-bind.test");
    const r = await signIn({ tid: T_HOME, oid: oid(3), mail: migrateEmail, email: migrateEmail, upn: migrateEmail, xmsEdov: true });
    expect(r.userId).toBeNull();
    expect(r.error).toBe("identity_conflict");
    const bound = await prisma.microsoftIdentity.findMany({ where: { userId: migrateId }, select: { objectId: true } });
    expect(bound.map((b) => b.objectId)).toEqual([oid(2)]);
  });

  it("refuses a token whose tid is not the configured tenant, even with a verified address", async () => {
    h.tenant = T_HOME;
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "ms-bind.test");
    const refused = await signIn({ tid: T_OTHER, oid: oid(4), email: domainEmail, upn: domainEmail, xmsEdov: true, acct: 0 });
    expect(refused.userId).toBeNull();
    expect(refused.error).toBe("ms_wrong_tenant");
    expect(await prisma.microsoftIdentity.count({ where: { objectId: oid(4) } })).toBe(0);
  });

  it("resolves a tenant configured as a domain and enforces it", async () => {
    h.tenant = "home.example.com";
    const refused = await signIn({ tid: T_OTHER, oid: oid(5), email: domainEmail, upn: domainEmail, xmsEdov: true });
    expect(refused.userId).toBeNull();
    // Positive control: the same sign-in from the domain's own tenant links.
    const ok = await signIn({ tid: T_HOME, oid: oid(5), email: domainEmail, upn: domainEmail, xmsEdov: true });
    expect(ok.error).toBeNull();
    expect(ok.userId).toBe(domainId);
  });

  it("multi-tenant: links by email only when xms_edov says the domain owner is verified", async () => {
    const unverified = await signIn({ tid: T_OTHER, oid: oid(6), email: edovEmail, upn: `x@other-${stamp}.example`, xmsEdov: false });
    expect(unverified.userId).toBeNull();
    expect(unverified.error).toBe("email_unverified");
    const verified = await signIn({ tid: T_OTHER, oid: oid(6), email: edovEmail, upn: `x@other-${stamp}.example`, xmsEdov: true });
    expect(verified.error).toBeNull();
    expect(verified.userId).toBe(edovId);
  });
});

describe("Microsoft vouches for an address only through xms_edov or a trusted member domain", () => {
  it("pinned tenant: the `email` claim alone links nothing, and says an administrator must finish setup", async () => {
    h.tenant = T_HOME;
    const r = await signIn({ tid: T_HOME, oid: oid(7), email: victimEmail, mail: victimEmail, upn: `v@home-${stamp}.example` });
    expect(r.userId).toBeNull();
    expect(r.error).toBe("ms_setup_incomplete");
    expect(await prisma.microsoftIdentity.count({ where: { objectId: oid(7) } })).toBe(0);
    expect(await usersWithEmail(victimEmail)).toBe(1);
  });

  it("never trusts a guest's sign-in name, or a personal account's, even on a trusted domain", async () => {
    vi.stubEnv("MICROSOFT_TRUSTED_DOMAINS", "ms-bind.test");
    const guest = await signIn({ tid: T_OTHER, oid: oid(8), upn: victimEmail, acct: 1 });
    const extGuest = await signIn({ tid: T_OTHER, oid: oid(8), upn: `victim_mail.test#ext#@ms-bind.test` });
    const personal = await signIn({ tid: MSA_TENANT_ID, oid: oid(8), upn: victimEmail, acct: 0 });
    for (const r of [guest, extGuest, personal]) {
      expect(r.userId).toBeNull();
      expect(r.error).toBe("email_unverified");
    }
    // Positive control: the same name from a member of a tenant links.
    const member = await signIn({ tid: T_OTHER, oid: oid(8), upn: victimEmail, acct: 0 });
    expect(member.userId).toBe(victimId);
  });
});

describe("Microsoft never links by address onto another first-party sign-in, or a platform admin", () => {
  it("refuses to link onto an account that already has Google, and asks for it to be connected from the profile", async () => {
    const email = `has-google-${stamp}@ms-bind.test`;
    const id = await mkUser(email, { googleId: `g-${stamp}` });
    vi.stubEnv("ALLOWED_EMAILS", [victimEmail, migrateEmail, edovEmail, domainEmail, email].join(","));
    const r = await signIn({ tid: T_OTHER, oid: oid(9), email, upn: email, xmsEdov: true });
    expect(r.userId).toBeNull();
    expect(r.error).toBe("link_from_profile");
    expect(await prisma.microsoftIdentity.count({ where: { userId: id } })).toBe(0);
  });

  it("refuses to link onto, or create, a platform admin's address", async () => {
    const existing = `ops-${stamp}@ms-bind.test`;
    const fresh = `ops-new-${stamp}@ms-bind.test`;
    const id = await mkUser(existing);
    vi.stubEnv("INTERNAL_ADMINS", `${existing},${fresh}`);
    vi.stubEnv("ALLOWED_EMAILS", [victimEmail, migrateEmail, edovEmail, domainEmail, existing, fresh].join(","));
    const link = await signIn({ tid: T_OTHER, oid: oid(10), email: existing, upn: existing, xmsEdov: true });
    const create = await signIn({ tid: T_OTHER, oid: oid(11), email: fresh, upn: fresh, xmsEdov: true });
    expect([link.error, create.error]).toEqual(["link_from_profile", "link_from_profile"]);
    expect([link.userId, create.userId]).toEqual([null, null]);
    expect(await prisma.microsoftIdentity.count({ where: { userId: id } })).toBe(0);
    expect(await usersWithEmail(fresh)).toBe(0);
  });
});

describe("Connect Microsoft (Profile, Sign-in methods) binds (tid, oid) to the signed-in account", () => {
  it("binds the identity to the account that asked, whatever address Microsoft has, and mints no session", async () => {
    const id = await mkUser(`connector-${stamp}@elsewhere.test`, { passwordHash: "x" });
    const sid = await sessionFor(id, { authMethod: "password" });
    const r = await connect({ tid: T_OTHER, oid: oid(12), upn: `someone@other-${stamp}.example` }, sid);
    expect(r.connectError).toBeNull();
    expect(r.connected).toBe("microsoft");
    expect(r.location.pathname).toBe(RETURN_TO);
    expect(r.userId).toBeNull(); // no new session
    expect(await boundTo(oid(12), T_OTHER)).toBe(id);
  });

  it("refuses when a different session is signed in by the time Microsoft returns", async () => {
    const a = await mkUser(`asker-${stamp}@elsewhere.test`);
    const b = await mkUser(`other-${stamp}@elsewhere.test`);
    const sa = await sessionFor(a, { authMethod: "password" });
    const sb = await sessionFor(b, { authMethod: "password" });
    const r = await connect({ tid: T_OTHER, oid: oid(13), upn: `x@other-${stamp}.example` }, sa, sb);
    expect(r.connectError).toBe("session_changed");
    expect(await prisma.microsoftIdentity.count({ where: { objectId: oid(13) } })).toBe(0);
  });

  it("refuses an identity already bound to another account", async () => {
    const id = await mkUser(`taker-${stamp}@elsewhere.test`);
    const sid = await sessionFor(id, { authMethod: "password" });
    const r = await connect({ tid: T_HOME, oid: oid(2), upn: migrateEmail }, sid);
    expect(r.connectError).toBe("identity_conflict");
    expect(await boundTo(oid(2))).toBe(migrateId);
  });

  // Not only a platform admin's: a session from before sessions recorded their
  // method may have come from the old sign-in that matched an address, and
  // connecting would make that one sign-in a permanent login.
  it("any account connects only from a session that vouches for its address", async () => {
    const id = await mkUser(`plain-conn-${stamp}@elsewhere.test`, { googleId: `g-plain-conn-${stamp}` });
    const legacy = await connect({ tid: T_OTHER, oid: oid(17), upn: `x@other-${stamp}.example` }, await sessionFor(id));
    expect(legacy.connectError).toBe("connect_sign_in_again");
    expect(legacy.location.pathname).toBe(RETURN_TO);
    expect(await prisma.microsoftIdentity.count({ where: { objectId: oid(17) } })).toBe(0);

    // Positive control: the same account, from its bound Google identity.
    const vouched = await connect({ tid: T_OTHER, oid: oid(17), upn: `x@other-${stamp}.example` }, await sessionFor(id, { authMethod: "google" }));
    expect(vouched.connectError).toBeNull();
    expect(vouched.connected).toBe("microsoft");
    expect(await boundTo(oid(17), T_OTHER)).toBe(id);
  });

  it("refuses a single sign-on session: an org's IdP must not plant a login that reaches the account's other orgs", async () => {
    const id = await mkUser(`sso-conn-${stamp}@elsewhere.test`);
    const sid = await sessionFor(id, { authMethod: "oidc" });
    const r = await connect({ tid: T_OTHER, oid: oid(14), upn: `x@other-${stamp}.example` }, sid);
    expect(r.connectError).toBe("connect_not_allowed");
    expect(await prisma.microsoftIdentity.count({ where: { objectId: oid(14) } })).toBe(0);
  });

  it("refuses a token from another tenant than the configured one", async () => {
    h.tenant = T_HOME;
    const id = await mkUser(`tenant-conn-${stamp}@elsewhere.test`);
    const sid = await sessionFor(id, { authMethod: "password" });
    const r = await connect({ tid: T_OTHER, oid: oid(15), upn: `x@other-${stamp}.example` }, sid);
    expect(r.connectError).toBe("ms_wrong_tenant");
    expect(r.location.pathname).toBe(RETURN_TO);
    expect(await prisma.microsoftIdentity.count({ where: { objectId: oid(15) } })).toBe(0);
  });

  it("starts only from a session allowed to connect", async () => {
    const start = (cookie: string) =>
      startConnect(
        new NextRequest("http://localhost/api/auth/microsoft/connect", {
          method: "POST",
          headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": nextIp() },
          body: new URLSearchParams({ returnTo: RETURN_TO }).toString(),
        }),
      );
    const id = await mkUser(`starter-${stamp}@elsewhere.test`);
    const ok = await start(`${SESSION_COOKIE}=${await sessionFor(id, { authMethod: "password" })}`);
    expect(ok.status).toBe(303);
    expect(new URL(ok.headers.get("location")!).hostname).toBe("login.microsoftonline.com");
    expect(ok.cookies.get(CONNECT_COOKIE)?.value).toBeTruthy();
    expect(ok.cookies.get(MS_STATE_COOKIE)?.value).toBeTruthy();

    const sso = await start(`${SESSION_COOKIE}=${await sessionFor(id, { authMethod: "oidc" })}`);
    expect(new URL(sso.headers.get("location")!).searchParams.get("connect_error")).toBe("connect_not_allowed");
    expect(sso.cookies.get(CONNECT_COOKIE)).toBeUndefined();

    const legacy = await start(`${SESSION_COOKIE}=${await sessionFor(id)}`);
    expect(new URL(legacy.headers.get("location")!).searchParams.get("connect_error")).toBe("connect_sign_in_again");
    expect(legacy.cookies.get(CONNECT_COOKIE)).toBeUndefined();

    const anon = await start("");
    expect(new URL(anon.headers.get("location")!).pathname).toBe("/login");
  });

  it("judges a request that presents a Cosmos bearer by the bearer alone, never by a session cookie riding along", async () => {
    const id = await mkUser(`bearer-${stamp}@elsewhere.test`, { passwordHash: "x" });
    const sid = await sessionFor(id, { authMethod: "password" });
    const withBearer = (authorization: string) =>
      new NextRequest("http://localhost/api/auth/microsoft/connect", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${sid}`,
          authorization,
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": nextIp(),
        },
        body: new URLSearchParams({ returnTo: RETURN_TO }).toString(),
      });
    // A key-shaped bearer skips the proxy's same-origin check, and a malformed one is still a bearer.
    for (const authorization of ["Bearer cosmos_0a1b2c_not-a-real-secret", "Bearer cosmos_garbage"]) {
      const res = await startConnect(withBearer(authorization));
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      expect(res.cookies.get(CONNECT_COOKIE)).toBeUndefined();
    }

    // The same on the way back: the callback won't bind to the cookie's session.
    next = { tid: T_OTHER, oid: oid(16), upn: `x@other-${stamp}.example` };
    const intent = connectCookieValue({ provider: "microsoft", state: "st4te", sessionId: sid, returnTo: RETURN_TO });
    const back = await GET(
      new NextRequest("http://localhost/api/auth/microsoft/callback?code=c0de&state=st4te", {
        headers: {
          cookie: `${MS_STATE_COOKIE}=st4te; ${CONNECT_COOKIE}=${intent}; ${SESSION_COOKIE}=${sid}`,
          authorization: "Bearer cosmos_0a1b2c_not-a-real-secret",
          "x-forwarded-for": nextIp(),
        },
      }),
    );
    expect(new URL(back.headers.get("location")!, "http://localhost").searchParams.get("connect_error")).toBe("session_changed");
    expect(await prisma.microsoftIdentity.count({ where: { objectId: oid(16) } })).toBe(0);
  });
});
