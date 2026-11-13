// @vitest-environment node
//
// A session minted by an organization's single sign-on opens THAT organization
// and no other. And an organization that requires single sign-on refuses every
// other kind of session, without stopping the person signing in: their other
// organizations still open.
//
// Together these replace two older rules that locked real people out: a first
// SSO link refused an account that also belonged to another org, and Google,
// Microsoft and password sign-in were refused outright for anyone in (or invited
// to) an org that requires SSO. Here the account links (it is a member of, or
// invited to, the IdP's org, at an address in the org's domains), and the
// session decides what it can open.
//
// Real database, real completeSsoLogin, real getAuthContext and a real route.
// The only stand-ins are the request cookie and header stores.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import type { IdpConnection } from "@prisma/client";

import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";

const h = vi.hoisted(() => ({ sessionId: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && h.sessionId ? { name, value: h.sessionId } : undefined),
  }),
  headers: async () => new Headers(),
}));

import { completeSsoLogin, type SsoClaims } from "./sso";
import { getAuthContext, getCurrentUser, sessionStillValid } from "./session";
import { orgSessionRefusal } from "./org-session-scope";
import { GET as getOrg } from "@/app/api/v1/orgs/[orgId]/route";
import { POST as passwordLogin } from "@/app/api/auth/password/login/route";
import { POST as mfaSetup } from "@/app/api/v1/me/mfa/setup/route";
import { SESSION_COOKIE } from "./client";

const stamp = Math.random().toString(36).slice(2, 8);
const DOM = `scope-${stamp}.test`;
const ISS_A = `https://idp-sa-${stamp}.example.com`;
const ISS_G = `https://idp-sg-${stamp}.example.com`;
const ADMIN_EMAIL = `root-${stamp}@${DOM}`;

type Org = { id: string; slug: string };
let orgA: Org, orgB: Org, orgG: Org, orgC: Org;
let connA: IdpConnection, connG: IdpConnection, connC: IdpConnection;
const userIds: string[] = [];
const orgIds: string[] = [];

async function mkOrg(tag: string, tenantClass: "GOV" | "COMMERCIAL" = "COMMERCIAL"): Promise<Org> {
  const o = await prisma.organization.create({
    data: { name: `${tag} ${stamp}`, slug: `${tag}-${stamp}`, tenantClass },
    select: { id: true, slug: true },
  });
  orgIds.push(o.id);
  return o;
}
async function mkUser(email: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { email, displayName: email.split("@")[0], ...extra } });
  userIds.push(u.id);
  return u.id;
}
const member = (orgId: string, userId: string, role: "MEMBER" | "ADMIN" = "MEMBER") =>
  prisma.orgMember.create({ data: { orgId, userId, role } });
const invite = (orgId: string, email: string) =>
  prisma.invitation.create({ data: { orgId, email, role: "MEMBER", expiresAt: new Date(Date.now() + 86_400_000) } });

const claims = (issuer: string, subject: string, email: string): SsoClaims =>
  ({ subject, email, emailVerified: true, groups: [], acr: null, amr: [], issuer }) as SsoClaims;

async function session(userId: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomBytes(16).toString("hex");
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3_600_000), ...extra } });
  return id;
}

/** getAuthContext as the holder of `sessionId` sees `org`. */
async function as(sessionId: string, org: Org) {
  h.sessionId = sessionId;
  // getAuthContext/getCurrentUser are React-cached per request; vitest has no
  // request scope, so each call here is its own "request".
  return getAuthContext(org.slug);
}
async function refusal(sessionId: string, org: Org) {
  h.sessionId = sessionId;
  const user = await getCurrentUser();
  const row = await prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { id: true, tenantClass: true } });
  return orgSessionRefusal(user!, row);
}
async function orgRoute(sessionId: string, org: Org) {
  h.sessionId = sessionId;
  const res = await getOrg(new NextRequest(`http://localhost/api/v1/orgs/${org.id}`), {
    params: Promise.resolve({ orgId: org.id }),
  });
  return res.status;
}

beforeAll(async () => {
  vi.stubEnv("INTERNAL_ADMINS", ADMIN_EMAIL);
  vi.stubEnv("ALLOWED_EMAILS", "");
  orgA = await mkOrg("sca");
  orgB = await mkOrg("scb");
  orgG = await mkOrg("scg", "GOV");
  orgC = await mkOrg("scc");
  for (const o of [orgA, orgG]) {
    await prisma.orgSecuritySettings.create({ data: { orgId: o.id, allowedDomains: [DOM] } });
  }
  connA = await prisma.idpConnection.create({ data: { orgId: orgA.id, issuerUrl: ISS_A, clientId: "c", clientSecretEnc: "x", enabled: true } });
  connG = await prisma.idpConnection.create({
    data: { orgId: orgG.id, issuerUrl: ISS_G, clientId: "c", clientSecretEnc: "x", enabled: true, enforced: true },
  });
  // A COMMERCIAL org whose connection says "enforced": enforcement is a GOV
  // control, so this one must NOT refuse other sessions.
  connC = await prisma.idpConnection.create({
    data: { orgId: orgC.id, issuerUrl: `https://idp-sc-${stamp}.example.com`, clientId: "c", clientSecretEnc: "x", enabled: true, enforced: true },
  });
});

beforeEach(() => {
  h.sessionId = null;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const strays = await prisma.user.findMany({ where: { email: { contains: stamp } }, select: { id: true } });
  const ids = [...new Set([...userIds, ...strays.map((u) => u.id)])];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.sessionRecord.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => undefined);
  await prisma.federatedIdentity.deleteMany({ where: { userId: { in: ids } } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.invitation.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.idpConnection.deleteMany({ where: { id: { in: [connA.id, connG.id, connC.id] } } });
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
});

describe("an SSO session opens only its own organization", () => {
  it("an account linked while in org A alone, later an ADMIN of org B: the A session opens A and not B", async () => {
    const email = `later-${stamp}@${DOM}`;
    const uid = await mkUser(email, { googleId: `g-later-${stamp}` });
    await member(orgA.id, uid);
    const first = await completeSsoLogin(orgA.slug, connA, claims(ISS_A, `s-later-${stamp}`, email), {});
    expect(first.ok && first.userId).toBe(uid);
    await member(orgB.id, uid, "ADMIN");

    const again = await completeSsoLogin(orgA.slug, connA, claims(ISS_A, `s-later-${stamp}`, email), {});
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    expect((await as(again.sessionId, orgA))?.userId).toBe(uid);
    expect(await as(again.sessionId, orgB)).toBeNull();
    expect(await refusal(again.sessionId, orgB)).toBe("sso_other_org");
    // The org API route refuses too, and serves the IdP's own org.
    expect(await orgRoute(again.sessionId, orgB)).toBe(401);
    expect(await orgRoute(again.sessionId, orgA)).toBe(200);

    // Positive control: the same account's Google session opens B as ADMIN.
    const google = await session(uid, { authMethod: "google" });
    expect((await as(google, orgB))?.orgRole).toBe("ADMIN");
    expect(await refusal(google, orgB)).toBeNull();
    expect(await orgRoute(google, orgB)).toBe(200);
  });

  it("an SSO session from a connection with no org match is refused everywhere but its own org", async () => {
    const email = `nowhere-${stamp}@${DOM}`;
    const uid = await mkUser(email);
    await member(orgB.id, uid);
    // A session that says it came through SSO but names no connection is not
    // first-party either: it opens nothing.
    const broken = await session(uid, { authMethod: "oidc" });
    expect(await as(broken, orgB)).toBeNull();
  });
});

describe("single sign-on links the people its org expects, and enforcement is per org", () => {
  it("a member of org B invited to the SSO-only org G links on SSO, and each session opens its own orgs", async () => {
    const email = `invited-${stamp}@${DOM}`;
    const uid = await mkUser(email, { googleId: `g-invited-${stamp}` });
    await member(orgB.id, uid);
    await invite(orgG.id, email);

    const sso = await completeSsoLogin(orgG.slug, connG, claims(ISS_G, `s-invited-${stamp}`, email), {});
    expect(sso.ok && sso.userId).toBe(uid);
    if (!sso.ok) return;
    expect(await prisma.invitation.count({ where: { orgId: orgG.id, email } })).toBe(0);
    expect((await as(sso.sessionId, orgG))?.userId).toBe(uid);
    expect(await as(sso.sessionId, orgB)).toBeNull();

    // Google still signs the person in: org B opens, the SSO-only org does not.
    const google = await session(uid, { authMethod: "google" });
    expect((await as(google, orgB))?.userId).toBe(uid);
    expect(await as(google, orgG)).toBeNull();
    expect(await refusal(google, orgG)).toBe("sso_required");
  });

  it("an account with no organization, invited to the SSO-only org, links on SSO", async () => {
    const email = `noorg-${stamp}@${DOM}`;
    const uid = await mkUser(email, { googleId: `g-noorg-${stamp}` });
    await invite(orgG.id, email);
    const sso = await completeSsoLogin(orgG.slug, connG, claims(ISS_G, `s-noorg-${stamp}`, email), {});
    expect(sso.ok && sso.userId).toBe(uid);
    if (!sso.ok) return;
    expect((await as(sso.sessionId, orgG))?.userId).toBe(uid);
  });

  it("a member of both the SSO-only org and another org links on its first SSO sign-in", async () => {
    const email = `both-${stamp}@${DOM}`;
    const uid = await mkUser(email, { googleId: `g-both-${stamp}` });
    await member(orgG.id, uid);
    await member(orgB.id, uid);
    const sso = await completeSsoLogin(orgG.slug, connG, claims(ISS_G, `s-both-${stamp}`, email), {});
    expect(sso.ok && sso.userId).toBe(uid);
    if (!sso.ok) return;
    expect((await as(sso.sessionId, orgG))?.userId).toBe(uid);
    expect(await as(sso.sessionId, orgB)).toBeNull();
  });

  it("an email-and-password invitee signs in with the password, then single sign-on links the same account", async () => {
    const email = `pw-${stamp}@${DOM}`;
    const password = `correct horse ${stamp} battery`;
    const uid = await mkUser(email, { passwordHash: hashPassword(password), passwordSetAt: new Date() });
    await member(orgB.id, uid);
    await invite(orgG.id, email);

    const res = await passwordLogin(
      new NextRequest("http://localhost/api/auth/password/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.79.0.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(res.status).toBe(200);
    const pwSession = res.cookies.get(SESSION_COOKIE)?.value;
    expect(pwSession).toBeTruthy();
    expect((await as(pwSession!, orgB))?.userId).toBe(uid);
    expect(await as(pwSession!, orgG)).toBeNull();

    const sso = await completeSsoLogin(orgG.slug, connG, claims(ISS_G, `s-pw-${stamp}`, email), {});
    expect(sso.ok && sso.userId).toBe(uid);
  });

  it("does not link an account its org neither holds nor invited (positive control for the rule above)", async () => {
    const email = `stranger-${stamp}@${DOM}`;
    const uid = await mkUser(email, { googleId: `g-stranger-${stamp}` });
    await member(orgB.id, uid);
    const sso = await completeSsoLogin(orgG.slug, connG, claims(ISS_G, `s-stranger-${stamp}`, email), {});
    expect(sso.ok).toBe(false);
    expect(!sso.ok && sso.reason).toBe("account_exists");
    expect(await prisma.federatedIdentity.count({ where: { userId: uid } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: uid } })).toBe(0);
  });

  it("a platform admin's own first-party session is the break-glass into an SSO-only org; an old session is not", async () => {
    const uid = await mkUser(ADMIN_EMAIL, { googleId: `g-root-${stamp}` });
    await member(orgG.id, uid, "ADMIN");
    const google = await session(uid, { authMethod: "google" });
    expect((await as(google, orgG))?.userId).toBe(uid);
    const legacy = await session(uid);
    expect(await as(legacy, orgG)).toBeNull();
  });

  it("only a GOV org's enforcement refuses other sessions", async () => {
    const email = `commercial-${stamp}@${DOM}`;
    const uid = await mkUser(email, { googleId: `g-commercial-${stamp}` });
    await member(orgC.id, uid);
    const google = await session(uid, { authMethod: "google" });
    expect((await as(google, orgC))?.userId).toBe(uid);
  });
});

describe("an SSO session doesn't change the account's own sign-in", () => {
  it("can't turn on two-factor for password sign-in; the same account's password session can", async () => {
    vi.stubEnv("SSO_VAULT_KEY", Buffer.alloc(32, 9).toString("base64"));
    const id = await mkUser(`mfa-${stamp}@${DOM}`, { passwordHash: hashPassword("a-long-enough-password-1") });
    await member(orgA.id, id);
    h.sessionId = await session(id, { authMethod: "oidc", idpConnId: connA.id });
    expect((await mfaSetup()).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id }, select: { mfaSecret: true } })).mfaSecret).toBeNull();

    h.sessionId = await session(id, { authMethod: "password" });
    expect((await mfaSetup()).status).toBe(200);
  });
});

describe("the org's floors and a long-lived stream follow the same session rules", () => {
  it("exempts a platform admin from the org's floors only on a session that vouches for the address", async () => {
    const org = await mkOrg("scf");
    await prisma.orgSecuritySettings.create({ data: { orgId: org.id, sessionTimeoutMins: 1 } });
    const admin = await prisma.user.findFirst({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    const uid = admin?.id ?? (await mkUser(ADMIN_EMAIL, { googleId: `g-root-${stamp}` }));
    await prisma.user.update({ where: { id: uid }, data: { googleId: `g-root-${stamp}` } });
    await member(org.id, uid, "ADMIN");
    const idle = { lastActivityAt: new Date(Date.now() - 10 * 60_000) };

    // The address alone is not the break-glass: a session from before sessions
    // recorded how they signed in is held to the idle timeout like anyone else.
    const legacy = await session(uid, idle);
    expect(await sessionStillValid(legacy, org.id, null)).toBe(false);
    expect(await as(legacy, org)).toBeNull();

    // Positive control: the admin's own Google session is exempt.
    const google = await session(uid, { authMethod: "google", ...idle });
    expect(await sessionStillValid(google, org.id, null)).toBe(true);
    expect((await as(google, org))?.userId).toBe(uid);
  });

  it("a stream opened by an SSO session stays valid for its own org only", async () => {
    const email = `stream-${stamp}@${DOM}`;
    const uid = await mkUser(email);
    await member(orgA.id, uid);
    await member(orgB.id, uid);
    const sso = await completeSsoLogin(orgA.slug, connA, claims(ISS_A, `s-stream-${stamp}`, email), {});
    expect(sso.ok).toBe(true);
    if (!sso.ok) return;
    expect(await sessionStillValid(sso.sessionId, orgA.id, null)).toBe(true);
    expect(await sessionStillValid(sso.sessionId, orgB.id, null)).toBe(false);
    // And an org that requires SSO ends a stream from any other kind of session.
    await member(orgG.id, uid);
    const pw = await session(uid, { authMethod: "password" });
    expect(await sessionStillValid(pw, orgB.id, null)).toBe(true);
    expect(await sessionStillValid(pw, orgG.id, null)).toBe(false);
  });
});
