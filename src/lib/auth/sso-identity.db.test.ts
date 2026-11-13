// @vitest-environment node
//
// An organization's identity provider is trusted for THAT organization only.
// It decides who signs in to its own org. It must not be able to:
//   - accept another org's pending invitation by asserting the invitee's address;
//   - take over an account that is not already a member of its org;
//   - mint a second account under an address someone already holds;
//   - produce a system admin, whether by creating the account, by linking to one,
//     or by an SSO session of an admin's account.
// And a binding is tied to the issuer that made it, so a connection re-pointed at
// a different IdP cannot inherit the old IdP's subjects.
//
// Runs completeSsoLogin and requireSystemAdmin against the real database. The
// only stand-in is the request cookie store that getCurrentUser reads.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { IdpConnection } from "@prisma/client";

import { prisma, prismaUnfiltered } from "@/lib/db/client";

const h = vi.hoisted(() => ({ sessionId: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && h.sessionId ? { name, value: h.sessionId } : undefined),
  }),
  headers: async () => new Headers(),
}));

import { completeSsoLogin, type SsoClaims } from "./sso";
import { getAuthContext } from "./session";
import { resolveFirstPartyUser } from "./first-party-identity";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";

const stamp = Math.random().toString(36).slice(2, 8);
const ISSUER_A = `https://idp-a-${stamp}.example.com`;
const DOMAIN_A = `sso-a-${stamp}.test`;
const ADMIN_EMAIL = `root-${stamp}@admin-${stamp}.test`;
const LATE_ADMIN_EMAIL = `late-${stamp}@admin-${stamp}.test`;

let orgA = { id: "", slug: "" };
let orgB = { id: "", slug: "" };
let conn: IdpConnection;
const userIds: string[] = [];

async function mkUser(email: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { email, displayName: email.split("@")[0], ...extra } });
  userIds.push(u.id);
  return u.id;
}

function claims(over: Partial<SsoClaims> & { subject: string }): SsoClaims {
  return {
    email: null,
    emailVerified: false,
    groups: [],
    acr: null,
    amr: [],
    issuer: ISSUER_A,
    ...over,
  } as SsoClaims;
}

async function login(c: SsoClaims) {
  const r = await completeSsoLogin(orgA.slug, conn, c, {});
  if (r.ok && !userIds.includes(r.userId)) userIds.push(r.userId);
  return r;
}

const isMember = async (orgId: string, userId: string) =>
  Boolean(await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { id: true } }));

async function session(userId: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomBytes(16).toString("hex");
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3_600_000), ...extra } });
  return id;
}

beforeAll(async () => {
  vi.stubEnv("INTERNAL_ADMINS", `${ADMIN_EMAIL},${LATE_ADMIN_EMAIL}`);
  orgA = await prisma.organization.create({ data: { name: `sso a ${stamp}`, slug: `sso-a-${stamp}` }, select: { id: true, slug: true } });
  orgB = await prisma.organization.create({ data: { name: `sso b ${stamp}`, slug: `sso-b-${stamp}` }, select: { id: true, slug: true } });
  await prisma.orgSecuritySettings.create({ data: { orgId: orgA.id, allowedDomains: [DOMAIN_A] } });
  conn = await prisma.idpConnection.create({
    data: {
      orgId: orgA.id,
      issuerUrl: ISSUER_A,
      clientId: "client",
      clientSecretEnc: "not-opened-by-these-tests",
      enabled: true,
    },
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const strays = await prisma.user.findMany({
    where: { OR: [{ email: { contains: stamp } }] },
    select: { id: true },
  });
  const ids = [...new Set([...userIds, ...strays.map((u) => u.id)])];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.sessionRecord.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }).catch(() => undefined);
  await prisma.federatedIdentity.deleteMany({ where: { userId: { in: ids } } });
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
  await prisma.invitation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
  await prisma.idpConnection.deleteMany({ where: { id: conn.id } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
});

const expires = () => new Date(Date.now() + 86_400_000);

describe("an IdP's invitations reach only its own organization", () => {
  it("consumes the authenticating org's invitation and leaves another org's alone", async () => {
    const email = `invitee-${stamp}@${DOMAIN_A}`;
    const invA = await prisma.invitation.create({ data: { orgId: orgA.id, email, role: "MEMBER", expiresAt: expires() } });
    const invB = await prisma.invitation.create({ data: { orgId: orgB.id, email, role: "ADMIN", expiresAt: expires() } });

    const r = await login(claims({ subject: `s-inv-${stamp}`, email, emailVerified: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Positive control: org A's own invitation was consumed.
    expect(await prisma.invitation.findUnique({ where: { id: invA.id } })).toBeNull();
    expect(await isMember(orgA.id, r.userId)).toBe(true);
    // Org B's invitation is untouched and grants nothing.
    expect(await prisma.invitation.findUnique({ where: { id: invB.id }, select: { id: true } })).not.toBeNull();
    expect(await isMember(orgB.id, r.userId)).toBe(false);
  });

  it("an unverified address consumes no invitation, even in the IdP's own org", async () => {
    const email = `unverified-${stamp}@${DOMAIN_A}`;
    const invA = await prisma.invitation.create({ data: { orgId: orgA.id, email, role: "ADMIN", expiresAt: expires() } });
    const r = await login(claims({ subject: `s-unv-${stamp}`, email, emailVerified: false }));
    expect(r.ok).toBe(true);
    expect(await prisma.invitation.findUnique({ where: { id: invA.id }, select: { id: true } })).not.toBeNull();
  });

  it("a verified address outside the org's allowed domains consumes no invitation", async () => {
    const email = `outsider-${stamp}@elsewhere-${stamp}.test`;
    const invA = await prisma.invitation.create({ data: { orgId: orgA.id, email, role: "ADMIN", expiresAt: expires() } });
    const r = await login(claims({ subject: `s-out-${stamp}`, email, emailVerified: true }));
    expect(r.ok).toBe(true);
    expect(await prisma.invitation.findUnique({ where: { id: invA.id }, select: { id: true } })).not.toBeNull();
  });
});

describe("an IdP links only to accounts its org already holds", () => {
  it("links a verified address to an existing member of the org", async () => {
    const email = `member-${stamp}@${DOMAIN_A}`;
    const memberId = await mkUser(email);
    await prisma.orgMember.create({ data: { orgId: orgA.id, userId: memberId, role: "MEMBER", permissions: "0" } });
    const r = await login(claims({ subject: `s-mem-${stamp}`, email, emailVerified: true }));
    expect(r.ok && r.userId).toBe(memberId);
    const bound = await prisma.federatedIdentity.findUnique({
      where: { idpConnId_subject: { idpConnId: conn.id, subject: `s-mem-${stamp}` } },
      select: { userId: true },
    });
    expect(bound?.userId).toBe(memberId);
  });

  it("links a member who also belongs to another org; that SSO session opens this org only", async () => {
    // Org A's admin runs org A's IdP and can assert any address in org A's
    // domains. The link is safe because the session it mints is scoped to org
    // A: it never opens org B, where the same account is an owner.
    const email = `multi-${stamp}@${DOMAIN_A}`;
    const userId = await mkUser(email);
    await prisma.orgMember.create({ data: { orgId: orgA.id, userId, role: "MEMBER", permissions: "0" } });
    await prisma.orgMember.create({ data: { orgId: orgB.id, userId, role: "OWNER", permissions: "0" } });

    const r = await login(claims({ subject: `s-multi-${stamp}`, email, emailVerified: true }));
    expect(r.ok && r.userId).toBe(userId);
    if (!r.ok) return;
    h.sessionId = r.sessionId;
    try {
      expect((await getAuthContext(orgA.slug))?.userId).toBe(userId);
      expect(await getAuthContext(orgB.slug)).toBeNull();
    } finally {
      h.sessionId = null;
    }
  });

  it("links an account the org has invited, and not one whose invitation expired or is for another org", async () => {
    // Someone who signed up with a password and was then invited: the org's
    // admin chose them, so their own IdP may sign them in to the account.
    const invited = `pw-invitee-${stamp}@${DOMAIN_A}`;
    const invitedId = await mkUser(invited, { passwordHash: "x" });
    await prisma.invitation.create({ data: { orgId: orgA.id, email: invited, role: "MEMBER", expiresAt: expires() } });
    const ok = await login(claims({ subject: `s-pwinv-${stamp}`, email: invited, emailVerified: true }));
    expect(ok.ok && ok.userId).toBe(invitedId);
    expect(await isMember(orgA.id, invitedId)).toBe(true);

    const lapsed = `lapsed-${stamp}@${DOMAIN_A}`;
    const lapsedId = await mkUser(lapsed);
    await prisma.invitation.create({
      data: { orgId: orgA.id, email: lapsed, role: "MEMBER", expiresAt: new Date(Date.now() - 60_000) },
    });
    const elsewhere = `elsewhere-${stamp}@${DOMAIN_A}`;
    const elsewhereId = await mkUser(elsewhere);
    await prisma.invitation.create({ data: { orgId: orgB.id, email: elsewhere, role: "MEMBER", expiresAt: expires() } });
    for (const [email, id, sub] of [
      [lapsed, lapsedId, `s-lapsed-${stamp}`],
      [elsewhere, elsewhereId, `s-else-${stamp}`],
    ] as const) {
      expect(await login(claims({ subject: sub, email, emailVerified: true }))).toEqual({ ok: false, reason: "account_exists" });
      expect(await prisma.federatedIdentity.count({ where: { userId: id } })).toBe(0);
      expect(await isMember(orgA.id, id)).toBe(false);
    }
  });

  it("does not link a verified address to an account outside the org, and mints no duplicate", async () => {
    const email = `stranger-${stamp}@${DOMAIN_A}`;
    const strangerId = await mkUser(email);
    await prisma.orgMember.create({ data: { orgId: orgB.id, userId: strangerId, role: "OWNER", permissions: "0" } });
    const r = await login(claims({ subject: `s-str-${stamp}`, email, emailVerified: true }));
    expect(r).toEqual({ ok: false, reason: "account_exists" });
    expect(await prisma.federatedIdentity.count({ where: { userId: strangerId } })).toBe(0);
    expect(await prisma.user.count({ where: { email: { equals: email, mode: "insensitive" } } })).toBe(1);
  });

  it("does not mint a duplicate account from an unverified address someone already holds", async () => {
    const email = `holder-${stamp}@${DOMAIN_A}`;
    const holderId = await mkUser(email);
    const r = await login(claims({ subject: `s-hold-${stamp}`, email: email.toUpperCase(), emailVerified: false }));
    expect(r).toEqual({ ok: false, reason: "email_untrusted" });
    expect(await prisma.federatedIdentity.count({ where: { userId: holderId } })).toBe(0);
    expect(await prisma.user.count({ where: { email: { equals: email, mode: "insensitive" } } })).toBe(1);
  });

  it("still creates a brand-new account for an address nobody holds, marked as IdP-provisioned", async () => {
    const email = `fresh-${stamp}@${DOMAIN_A}`;
    const r = await login(claims({ subject: `s-fresh-${stamp}`, email, emailVerified: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = await prisma.user.findUnique({ where: { id: r.userId }, select: { email: true, ssoProvisioned: true } });
    expect(u).toEqual({ email, ssoProvisioned: true });
    expect(await isMember(orgA.id, r.userId)).toBe(true);
  });
});

describe("an org that lists no domains is trusted for no address", () => {
  // Most orgs list none. Its IdP then vouches for no address, so a new account
  // gets a placeholder, and can't sit on the address of someone who has not
  // signed up yet.
  let bare = { id: "", slug: "" };
  let bareConn: IdpConnection;
  const BARE_ISSUER = `https://idp-bare-${stamp}.example.com`;
  beforeAll(async () => {
    bare = await prisma.organization.create({ data: { name: `sso bare ${stamp}`, slug: `sso-bare-${stamp}` }, select: { id: true, slug: true } });
    bareConn = await prisma.idpConnection.create({
      data: { orgId: bare.id, issuerUrl: BARE_ISSUER, clientId: "c", clientSecretEnc: "x", enabled: true },
    });
  });
  afterAll(async () => {
    const ids = (await prisma.federatedIdentity.findMany({ where: { idpConnId: bareConn.id }, select: { userId: true } })).map((f) => f.userId);
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.sessionRecord.deleteMany({ where: { orgId: bare.id } }).catch(() => undefined);
    await prisma.federatedIdentity.deleteMany({ where: { idpConnId: bareConn.id } });
    await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: bare.id } });
    await prisma.idpConnection.deleteMany({ where: { id: bareConn.id } });
    await prisma.organization.deleteMany({ where: { id: bare.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  });

  it("creates the account under a placeholder, and the address's real owner can still sign in with Google", async () => {
    const victim = `victim-${stamp}@mail-${stamp}.test`;
    const r = await completeSsoLogin(
      bare.slug,
      bareConn,
      claims({ subject: `s-squat-${stamp}`, email: victim, emailVerified: true, issuer: BARE_ISSUER }),
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const made = await prisma.user.findUniqueOrThrow({ where: { id: r.userId }, select: { email: true, ssoProvisioned: true } });
    expect(made.ssoProvisioned).toBe(true);
    expect(made.email).toMatch(/@sso\.local$/);

    vi.stubEnv("ALLOWED_EMAILS", victim);
    const real = await resolveFirstPartyUser({
      identity: { provider: "google", subject: `g-victim-${stamp}` },
      verifiedEmails: [victim],
      profile: { displayName: "Real owner" },
    });
    expect(real.ok).toBe(true);
    if (real.ok) {
      userIds.push(real.user.id);
      expect(real.user.id).not.toBe(r.userId);
      expect(real.user.email).toBe(victim);
    }
  });
});

describe("a binding belongs to the issuer that made it", () => {
  it("refuses a binding that another issuer made", async () => {
    const email = `iss-${stamp}@${DOMAIN_A}`;
    const userId = await mkUser(email);
    await prisma.orgMember.create({ data: { orgId: orgA.id, userId, role: "MEMBER", permissions: "0" } });
    await prisma.federatedIdentity.create({
      data: { userId, idpConnId: conn.id, subject: `s-iss-${stamp}`, issuer: `https://old-idp-${stamp}.example.com` },
    });
    const r = await login(claims({ subject: `s-iss-${stamp}`, email, emailVerified: true }));
    expect(r.ok).toBe(false);
  });

  it("accepts a binding made before issuers were recorded, and records the issuer", async () => {
    const email = `legacy-${stamp}@${DOMAIN_A}`;
    const userId = await mkUser(email);
    await prisma.orgMember.create({ data: { orgId: orgA.id, userId, role: "MEMBER", permissions: "0" } });
    await prisma.federatedIdentity.create({ data: { userId, idpConnId: conn.id, subject: `s-leg-${stamp}` } });
    const r = await login(claims({ subject: `s-leg-${stamp}`, email, emailVerified: false }));
    expect(r.ok && r.userId).toBe(userId);
    const row = await prisma.federatedIdentity.findUnique({
      where: { idpConnId_subject: { idpConnId: conn.id, subject: `s-leg-${stamp}` } },
      select: { issuer: true },
    });
    expect(row?.issuer).toBe(ISSUER_A);
  });
});

describe("an IdP never produces a system admin", () => {
  it("refuses to create an account under a system-admin address", async () => {
    for (const emailVerified of [false, true]) {
      const r = await login(claims({ subject: `s-root-${emailVerified}-${stamp}`, email: ADMIN_EMAIL, emailVerified }));
      expect(r.ok).toBe(false);
    }
    expect(await prisma.user.count({ where: { email: { equals: ADMIN_EMAIL, mode: "insensitive" } } })).toBe(0);
  });

  it("refuses to link an IdP subject to a system admin's existing account", async () => {
    const adminId = await mkUser(LATE_ADMIN_EMAIL, { googleId: `g-late-${stamp}` });
    await prisma.orgMember.create({ data: { orgId: orgA.id, userId: adminId, role: "MEMBER", permissions: "0" } });
    const r = await login(claims({ subject: `s-late-${stamp}`, email: LATE_ADMIN_EMAIL, emailVerified: true }));
    expect(r.ok && r.userId).not.toBe(adminId);
    expect(await prisma.federatedIdentity.count({ where: { userId: adminId } })).toBe(0);
  });

  it("an IdP-provisioned account is not a system admin even if its address is listed later", async () => {
    // The shape an IdP-made account has once its address appears in INTERNAL_ADMINS,
    // signed in through a non-SSO session (e.g. a password set from its SSO session).
    const email = `squat-${stamp}@admin-${stamp}.test`;
    vi.stubEnv("INTERNAL_ADMINS", `${ADMIN_EMAIL},${LATE_ADMIN_EMAIL},${email}`);
    try {
      const squatId = await mkUser(email, { ssoProvisioned: true });
      h.sessionId = await session(squatId, { authMethod: "password" });
      expect(await requireSystemAdmin()).toBeNull();
    } finally {
      vi.stubEnv("INTERNAL_ADMINS", `${ADMIN_EMAIL},${LATE_ADMIN_EMAIL}`);
    }
  });

  it("an SSO session never confers system admin; the same account's first-party session does", async () => {
    const adminId = (await prisma.user.findFirst({ where: { email: LATE_ADMIN_EMAIL }, select: { id: true } }))!.id;
    // Positive control: a Google session of the listed account (its Google id is bound).
    h.sessionId = await session(adminId, { authMethod: "google" });
    expect((await requireSystemAdmin())?.id).toBe(adminId);
    // The same account, through an SSO session.
    h.sessionId = await session(adminId, { authMethod: "oidc", idpConnId: conn.id });
    expect(await requireSystemAdmin()).toBeNull();
  });
});
