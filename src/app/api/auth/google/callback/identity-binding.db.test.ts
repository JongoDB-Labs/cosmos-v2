// @vitest-environment node
//
// Google sign-in binds an account to the Google subject (`sub`). Email links a
// first sign-in to an existing account only when Google says the address is
// verified (`email_verified === true`) and the account has no Google identity
// yet. After that the subject decides, so a changed address still reaches the
// same account and a second Google account for the same address cannot.
//
// Google is faked at the HTTP boundary: the real google-auth-library client
// exchanges the code and verifies a real RS256 signature, with its token and
// certificate endpoints answered by a local fake. Assertions read the session's
// USER ID; `User.email` is not unique, so an email assertion proves nothing.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";

import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE } from "@/lib/auth/client";
import { CONNECT_COOKIE, connectCookieValue } from "@/lib/auth/connect-sign-in";

const keys = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
});

const h = vi.hoisted(() => ({
  next: null as null | { sub: string; email: string; email_verified: boolean },
}));

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function signedIdToken(claims: { sub: string; email: string; email_verified: boolean }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-kid" });
  const payload = b64url({
    iss: "https://accounts.google.com",
    aud: "g-client-id",
    iat: now,
    exp: now + 600,
    name: "Fake Googler",
    ...claims,
  });
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    if (!h.next) throw new Error("no identity queued");
    return json({ access_token: "at", id_token: signedIdToken(h.next), token_type: "Bearer", expires_in: 3600 });
  }
  if (url.startsWith("https://www.googleapis.com/oauth2/v1/certs")) {
    return json({ "test-kid": keys.publicKey.export({ type: "spki", format: "pem" }).toString() });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
});

vi.mock("@/lib/auth/google-oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/google-oauth")>();
  const { OAuth2Client } = await import("google-auth-library");
  return {
    ...real,
    resolveGoogleLoginCreds: async () => ({ clientId: "g-client-id", clientSecret: "g-secret" }),
    // The REAL client, with only its transport pointed at the fake.
    getGoogleLoginClient: async (redirectUri?: string) =>
      new OAuth2Client({
        clientId: "g-client-id",
        clientSecret: "g-secret",
        redirectUri,
        transporterOptions: { fetchImplementation: fakeFetch as unknown as typeof fetch },
      }),
  };
});

import { GET } from "./route";

const stamp = Math.random().toString(36).slice(2, 8);
const existingEmail = `g-existing-${stamp}@g-bind.test`;
const renamedEmail = `g-renamed-${stamp}@g-bind.test`;
const preboundEmail = `g-prebound-${stamp}@g-bind.test`;
const SUB_LEGIT = `sub-legit-${stamp}`;
const SUB_OTHER = `sub-other-${stamp}`;
const SUB_PREBOUND = `sub-prebound-${stamp}`;

let existingId = "", preboundId = "";
const touched: string[] = [];

let ipCounter = 0;
async function signIn(identity: { sub: string; email: string; email_verified: boolean }, extraCookie = "") {
  h.next = identity;
  const req = new NextRequest("http://localhost/api/auth/google/callback?code=c0de&state=st4te", {
    headers: {
      cookie: `${OAUTH_STATE_COOKIE}=st4te${extraCookie}`,
      "x-forwarded-for": `10.78.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`,
    },
  });
  const res = await GET(req);
  const location = new URL(res.headers.get("location") ?? "/", "http://localhost");
  const error = location.searchParams.get("error");
  const sessionId = res.cookies.get(SESSION_COOKIE)?.value;
  if (!sessionId) return { userId: null as string | null, error, authMethod: null as string | null, location };
  const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { userId: true, authMethod: true } });
  if (s) touched.push(s.userId);
  return { userId: s?.userId ?? null, error, authMethod: s?.authMethod ?? null, location };
}

async function mkUser(email: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { email, displayName: email.split("@")[0], ...extra } });
  touched.push(u.id);
  return u.id;
}

async function sessionFor(userId: string, extra: Record<string, unknown> = {}) {
  const id = `g-test-${stamp}-${Math.random().toString(36).slice(2)}`;
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3_600_000), ...extra } });
  return id;
}

const RETURN_TO = "/acme/settings/profile";

async function connect(identity: { sub: string; email: string; email_verified: boolean }, sessionId: string, asSessionId = sessionId) {
  const intent = connectCookieValue({ provider: "google", state: "st4te", sessionId, returnTo: RETURN_TO });
  const r = await signIn(identity, `; ${CONNECT_COOKIE}=${intent}; ${SESSION_COOKIE}=${asSessionId}`);
  return { ...r, connected: r.location.searchParams.get("connected"), connectError: r.location.searchParams.get("connect_error") };
}

const googleIdOf = async (id: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id }, select: { googleId: true } })).googleId;

beforeAll(async () => {
  vi.stubEnv("ALLOWED_EMAILS", [existingEmail, preboundEmail].join(","));
  existingId = (await prisma.user.create({ data: { email: existingEmail, displayName: "Existing" } })).id;
  // Bound before this change (the shape every current Google user already has).
  preboundId = (
    await prisma.user.create({ data: { email: preboundEmail, displayName: "Prebound", googleId: SUB_PREBOUND } })
  ).id;
  touched.push(existingId, preboundId);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const strays = await prisma.user.findMany({
    where: { OR: [{ email: { in: [existingEmail, renamedEmail, preboundEmail] } }, { email: { contains: stamp } }] },
    select: { id: true },
  });
  const ids = [...new Set([...touched, ...strays.map((u) => u.id)])];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("Google sign-in binds the account to the Google subject", () => {
  it("an unverified Google address cannot sign in as the existing account", async () => {
    const r = await signIn({ sub: SUB_OTHER, email: existingEmail, email_verified: false });
    expect(r.userId).not.toBe(existingId);
    expect(r.userId).toBeNull();
    expect(r.error).toBeTruthy();
    const row = await prisma.user.findUnique({ where: { id: existingId }, select: { googleId: true } });
    expect(row?.googleId).toBeNull();
  });

  it("a verified first sign-in links the existing account and binds the subject (the migration path)", async () => {
    const r = await signIn({ sub: SUB_LEGIT, email: existingEmail, email_verified: true });
    expect(r.error).toBeNull();
    expect(r.userId).toBe(existingId);
    // The session records how it signed in, which is what system admin reads.
    expect(r.authMethod).toBe("google");
    const row = await prisma.user.findUnique({ where: { id: existingId }, select: { googleId: true } });
    expect(row?.googleId).toBe(SUB_LEGIT);
  });

  it("later sign-ins match by subject even when the address changes", async () => {
    const r = await signIn({ sub: SUB_LEGIT, email: renamedEmail, email_verified: true });
    expect(r.error).toBeNull();
    expect(r.userId).toBe(existingId);
    expect(await prisma.user.count({ where: { email: renamedEmail } })).toBe(0);
  });

  it("a second Google account with the same verified address cannot replace the bound one", async () => {
    const r = await signIn({ sub: SUB_OTHER, email: existingEmail, email_verified: true });
    expect(r.userId).not.toBe(existingId);
    expect(r.userId).toBeNull();
    expect(r.error).toBeTruthy();
    const row = await prisma.user.findUnique({ where: { id: existingId }, select: { googleId: true } });
    expect(row?.googleId).toBe(SUB_LEGIT);
  });

  it("an account bound before this change keeps signing in by subject", async () => {
    const r = await signIn({ sub: SUB_PREBOUND, email: preboundEmail, email_verified: true });
    expect(r.error).toBeNull();
    expect(r.userId).toBe(preboundId);
  });
});

describe("Google never signs in to an account an organization's IdP made", () => {
  it("refuses the address's only account when an IdP made it, and makes no second one", async () => {
    const email = `g-idp-made-${stamp}@g-bind.test`;
    const id = await mkUser(email, { ssoProvisioned: true });
    vi.stubEnv("ALLOWED_EMAILS", [existingEmail, preboundEmail, email].join(","));
    const r = await signIn({ sub: `sub-idp-${stamp}`, email, email_verified: true });
    expect(r.userId).toBeNull();
    expect(r.error).toBe("sso_account");
    expect(await googleIdOf(id)).toBeNull();
    expect(await prisma.user.count({ where: { email: { equals: email, mode: "insensitive" } } })).toBe(1);
  });
});

describe("two first Google sign-ins racing for one account", () => {
  it("the second does not overwrite the binding the first wrote a moment earlier", async () => {
    const email = `g-race-${stamp}@g-bind.test`;
    const id = await mkUser(email);
    vi.stubEnv("ALLOWED_EMAILS", [existingEmail, preboundEmail, email].join(","));
    // The second sign-in reads the account while it is still unbound; the first
    // binds it before the second writes.
    const realFindMany = prisma.user.findMany.bind(prisma.user);
    const spy = vi.spyOn(prisma.user, "findMany").mockImplementationOnce((async (args: Parameters<typeof realFindMany>[0]) => {
      const stale = await realFindMany(args);
      await prisma.user.update({ where: { id }, data: { googleId: `sub-race-first-${stamp}` } });
      return stale;
    }) as unknown as typeof prisma.user.findMany);
    try {
      const r = await signIn({ sub: `sub-race-second-${stamp}`, email, email_verified: true });
      expect(spy).toHaveBeenCalled();
      expect(r.userId).toBeNull();
      expect(r.error).toBe("identity_conflict");
      expect(await googleIdOf(id)).toBe(`sub-race-first-${stamp}`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Connect Google (Profile, Sign-in methods) binds the subject to the signed-in account", () => {
  // Not only a platform admin's: a session from before sessions recorded their
  // method may have come from a sign-in that matched an unverified address, and
  // connecting would make that one sign-in a permanent login.
  it("any account connects only from a session that vouches for its address", async () => {
    const id = await mkUser(`g-plain-${stamp}@elsewhere.test`, { passwordHash: "x" });
    const identity = { sub: `sub-plain-${stamp}`, email: `plain-${stamp}@gmail.test`, email_verified: true };

    const legacy = await connect(identity, await sessionFor(id));
    expect(legacy.connectError).toBe("connect_sign_in_again");
    expect(legacy.location.pathname).toBe(RETURN_TO);
    expect(await googleIdOf(id)).toBeNull();

    await prisma.user.update({ where: { id }, data: { passwordUntrusted: true } });
    const untrusted = await connect(identity, await sessionFor(id, { authMethod: "password" }));
    expect(untrusted.connectError).toBe("connect_password_untrusted");
    expect(await googleIdOf(id)).toBeNull();

    // Positive control: the same account, from a password session that vouches.
    await prisma.user.update({ where: { id }, data: { passwordUntrusted: false } });
    const vouched = await connect(identity, await sessionFor(id, { authMethod: "password" }));
    expect(vouched.connected).toBe("google");
    expect(await googleIdOf(id)).toBe(`sub-plain-${stamp}`);
  });

  it("binds the subject to the account that asked, whatever address Google has, and mints no session", async () => {
    const id = await mkUser(`g-connector-${stamp}@elsewhere.test`, { passwordHash: "x" });
    const sid = await sessionFor(id, { authMethod: "password" });
    const r = await connect({ sub: `sub-conn-${stamp}`, email: `personal-${stamp}@gmail.test`, email_verified: false }, sid);
    expect(r.connected).toBe("google");
    expect(r.location.pathname).toBe(RETURN_TO);
    expect(r.userId).toBeNull();
    expect(await googleIdOf(id)).toBe(`sub-conn-${stamp}`);
  });

  it("refuses when a different session is signed in by the time Google returns", async () => {
    const a = await mkUser(`g-asker-${stamp}@elsewhere.test`);
    const b = await mkUser(`g-other-${stamp}@elsewhere.test`);
    const r = await connect(
      { sub: `sub-swap-${stamp}`, email: `x-${stamp}@gmail.test`, email_verified: true },
      await sessionFor(a, { authMethod: "password" }),
      await sessionFor(b, { authMethod: "password" }),
    );
    expect(r.connectError).toBe("session_changed");
    expect([await googleIdOf(a), await googleIdOf(b)]).toEqual([null, null]);
  });

  it("refuses a subject already bound to another account, and an account that already has a different Google identity", async () => {
    const id = await mkUser(`g-taker-${stamp}@elsewhere.test`);
    const taken = await connect({ sub: SUB_PREBOUND, email: preboundEmail, email_verified: true }, await sessionFor(id, { authMethod: "password" }));
    expect(taken.connectError).toBe("identity_conflict");
    const r = await connect({ sub: `sub-second-${stamp}`, email: existingEmail, email_verified: true }, await sessionFor(existingId, { authMethod: "google" }));
    expect(r.connectError).toBe("already_connected");
    expect(await googleIdOf(existingId)).toBe(SUB_LEGIT);
  });

  it("a platform admin's account connects only from a session that vouches for its address", async () => {
    const email = `g-ops-${stamp}@admin-${stamp}.test`;
    vi.stubEnv("INTERNAL_ADMINS", email);
    try {
      const id = await mkUser(email, { passwordHash: "x" });
      const legacy = await connect({ sub: `sub-ops-${stamp}`, email: `ops-${stamp}@gmail.test`, email_verified: true }, await sessionFor(id));
      expect(legacy.connectError).toBe("connect_sign_in_again");
      expect(await googleIdOf(id)).toBeNull();
      const vouched = await connect({ sub: `sub-ops-${stamp}`, email: `ops-${stamp}@gmail.test`, email_verified: true }, await sessionFor(id, { authMethod: "password" }));
      expect(vouched.connected).toBe("google");
      expect(await googleIdOf(id)).toBe(`sub-ops-${stamp}`);
    } finally {
      vi.stubEnv("INTERNAL_ADMINS", "");
    }
  });
});
