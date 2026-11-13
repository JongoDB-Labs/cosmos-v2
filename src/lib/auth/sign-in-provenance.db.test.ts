// @vitest-environment node
//
// System admin follows the credential that signed the session in, and that
// credential must vouch for the account's address first-hand:
//   - a Google session, through the account's bound Google identity;
//   - a Microsoft session, through its bound (tenant, object) identity;
//   - a password session, through a password no SSO session could have set.
// An organization's IdP vouches for nothing here: it can't set a first password,
// the accounts it created stay excluded however they sign in later, and it can't
// park an address it hasn't verified on a new account.
//
// Runs against the real database; the only stand-in is the request cookie store.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import type { IdpConnection } from "@prisma/client";

import { prisma, prismaUnfiltered } from "@/lib/db/client";

const h = vi.hoisted(() => ({ sessionId: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "session" && h.sessionId ? { name, value: h.sessionId } : undefined),
  }),
  headers: async () => new Headers(),
}));

import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { completeSsoLogin, type SsoClaims } from "./sso";
import { resolveFirstPartyUser } from "./first-party-identity";
import { createPasswordResetToken } from "./password-reset";
import { hashPassword } from "./password";
import { POST as setOwnPassword } from "@/app/api/v1/me/password/route";
import { POST as confirmReset } from "@/app/api/auth/password/reset/confirm/route";
import { GET as listFlagged } from "@/app/api/v1/admin/sso-provisioned/route";
import { DELETE as clearFlag } from "@/app/api/v1/admin/sso-provisioned/[userId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
const ADMIN_DOMAIN = `adm-${stamp}.test`;
const ORG_DOMAIN = `org-${stamp}.test`;
const ISSUER = `https://idp-${stamp}.example.com`;
const NEW_PASSWORD = "a-long-enough-password-9";

let org = { id: "", slug: "" };
let conn: IdpConnection;
const userIds: string[] = [];
const listed: string[] = [];

async function mkUser(email: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { email, displayName: email.split("@")[0], ...extra } });
  userIds.push(u.id);
  return u.id;
}

/** An address on the INTERNAL_ADMINS list for this file. */
function adminAddress(tag: string) {
  const email = `${tag}-${stamp}@${ADMIN_DOMAIN}`;
  listed.push(email);
  vi.stubEnv("INTERNAL_ADMINS", listed.join(","));
  return email;
}

async function signIn(userId: string, extra: Record<string, unknown> = {}) {
  const id = crypto.randomBytes(16).toString("hex");
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3_600_000), ...extra } });
  h.sessionId = id;
  return id;
}

const isAdmin = async () => (await requireSystemAdmin()) != null;

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const setPassword = () => setOwnPassword(jsonRequest("http://localhost/api/v1/me/password", { newPassword: NEW_PASSWORD }));

function claims(over: Partial<SsoClaims> & { subject: string }): SsoClaims {
  return { email: null, emailVerified: false, groups: [], acr: null, amr: [], issuer: ISSUER, ...over } as SsoClaims;
}

beforeAll(async () => {
  vi.stubEnv("SSO_VAULT_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("INTERNAL_ADMINS", "");
  org = await prisma.organization.create({ data: { name: `prov ${stamp}`, slug: `prov-${stamp}` }, select: { id: true, slug: true } });
  await prisma.orgSecuritySettings.create({ data: { orgId: org.id, allowedDomains: [ORG_DOMAIN] } });
  conn = await prisma.idpConnection.create({
    data: { orgId: org.id, issuerUrl: ISSUER, clientId: "client", clientSecretEnc: "unused", enabled: true },
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const strays = await prisma.user.findMany({
    where: { OR: [{ email: { contains: stamp } }, { federatedIdentities: { some: { idpConnId: conn.id } } }] },
    select: { id: true },
  });
  const ids = [...new Set([...userIds, ...strays.map((u) => u.id)])];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.sessionRecord.deleteMany({ where: { orgId: org.id } }).catch(() => undefined);
  await prisma.federatedIdentity.deleteMany({ where: { userId: { in: ids } } });
  await prisma.microsoftIdentity.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: org.id } });
  await prisma.idpConnection.deleteMany({ where: { id: conn.id } });
  await prisma.orgSecuritySettings.deleteMany({ where: { orgId: org.id } });
  await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
});

describe("a session is a system admin only through a first-party credential", () => {
  it("a Google session counts through the bound Google identity; a session from before sessions recorded their method does not", async () => {
    const email = adminAddress("google");
    const id = await mkUser(email, { googleId: `g-${stamp}` });
    // Positive control: a Google session of the bound account.
    await signIn(id, { authMethod: "google" });
    expect(await isAdmin()).toBe(true);
    // A session minted before this change (no recorded method) could have come
    // from a sign-in that matched by an unverified address. Sign in again.
    await signIn(id);
    expect(await isAdmin()).toBe(false);
  });

  it("a Microsoft session counts only with a bound Microsoft identity", async () => {
    const email = adminAddress("ms");
    const id = await mkUser(email);
    await signIn(id, { authMethod: "microsoft" });
    expect(await isAdmin()).toBe(false);
    await prisma.microsoftIdentity.create({ data: { userId: id, tenantId: crypto.randomUUID(), objectId: crypto.randomUUID() } });
    expect(await isAdmin()).toBe(true);
  });

  it("a password session counts only while its password vouches for the address", async () => {
    const email = adminAddress("pw");
    const id = await mkUser(email, {
      passwordHash: hashPassword("an-old-password-123"),
      passwordSetAt: new Date(),
      passwordUntrusted: true,
    });
    await signIn(id, { authMethod: "password" });
    expect(await isAdmin()).toBe(false);

    // An emailed reset proves the mailbox, and the new password vouches.
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, passwordHash: true, passwordSetAt: true } });
    const token = createPasswordResetToken(u);
    const res = await confirmReset(jsonRequest("http://localhost/api/auth/password/reset/confirm", { token, newPassword: NEW_PASSWORD }));
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id }, select: { passwordUntrusted: true } })).passwordUntrusted).toBe(false);
    await signIn(id, { authMethod: "password" });
    expect(await isAdmin()).toBe(true);
  });

  it("an IdP-provisioned account is never a system admin, whatever credential it later gains", async () => {
    const email = adminAddress("squat");
    const id = await mkUser(email, { ssoProvisioned: true, googleId: `g-sq-${stamp}`, passwordHash: hashPassword("x".repeat(12)) });
    for (const authMethod of ["google", "password"]) {
      await signIn(id, { authMethod });
      expect(await isAdmin()).toBe(false);
    }
  });
});

describe("a first password needs a first-party sign-in", () => {
  it("an SSO session cannot set a first password, even on an account an IdP did not create", async () => {
    // The shape of an admin's account that an IdP was linked to before linking
    // was restricted: first-party account, an SSO binding, no password yet.
    const email = adminAddress("linked");
    const id = await mkUser(email, { googleId: `g-ln-${stamp}` });
    await prisma.federatedIdentity.create({ data: { userId: id, idpConnId: conn.id, subject: `s-ln-${stamp}`, issuer: ISSUER } });
    await signIn(id, { authMethod: "oidc", idpConnId: conn.id });
    const res = await setPassword();
    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true } })).passwordHash).toBeNull();
  });

  it("an IdP-provisioned account cannot set a first password from any session", async () => {
    const id = await mkUser(`jit-${stamp}@${ORG_DOMAIN}`, { ssoProvisioned: true });
    for (const extra of [{ authMethod: "oidc", idpConnId: conn.id }, {}]) {
      await signIn(id, extra);
      expect((await setPassword()).status).toBe(403);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true } })).passwordHash).toBeNull();
  });

  it("a Google session of the bound account can set one (positive control)", async () => {
    const id = await mkUser(`gpw-${stamp}@example.com`, { googleId: `g-pw-${stamp}` });
    await signIn(id, { authMethod: "google" });
    expect((await setPassword()).status).toBe(200);
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true } });
    expect(u.passwordHash).not.toBeNull();
  });
});

describe("an IdP keeps an address it has not verified off the account it creates", () => {
  it("stores a placeholder for an unverified address, and the address's owner can still sign in with Google", async () => {
    const real = `victim-${stamp}@${ORG_DOMAIN}`;
    const r = await completeSsoLogin(org.slug, conn, claims({ subject: `s-v-${stamp}`, email: real, emailVerified: false }), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    userIds.push(r.userId);
    const made = await prisma.user.findUniqueOrThrow({ where: { id: r.userId }, select: { email: true, ssoProvisioned: true } });
    expect(made.ssoProvisioned).toBe(true);
    expect(made.email.toLowerCase()).not.toBe(real);
    expect(made.email).toMatch(/@sso\.local$/);

    // The real owner's first verified Google sign-in is not blocked by it.
    await prisma.allowedEmail.create({ data: { email: real, addedBy: `test-${stamp}` } });
    try {
      const g = await resolveFirstPartyUser({
        identity: { provider: "google", subject: `g-victim-${stamp}` },
        verifiedEmails: [real],
        profile: { displayName: "Victim" },
      });
      expect(g.ok).toBe(true);
      if (g.ok) {
        userIds.push(g.user.id);
        expect(g.user.id).not.toBe(r.userId);
      }
    } finally {
      await prisma.allowedEmail.deleteMany({ where: { email: real } });
    }
  });

  it("stores a placeholder for a verified address outside the org's allowed domains", async () => {
    const outside = `someone-${stamp}@elsewhere-${stamp}.test`;
    const r = await completeSsoLogin(org.slug, conn, claims({ subject: `s-o-${stamp}`, email: outside, emailVerified: true }), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    userIds.push(r.userId);
    const made = await prisma.user.findUniqueOrThrow({ where: { id: r.userId }, select: { email: true } });
    expect(made.email.toLowerCase()).not.toBe(outside);
  });

  it("keeps a verified address in the org's domains (positive control)", async () => {
    const trusted = `employee-${stamp}@${ORG_DOMAIN}`;
    const r = await completeSsoLogin(org.slug, conn, claims({ subject: `s-t-${stamp}`, email: trusted, emailVerified: true }), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    userIds.push(r.userId);
    const made = await prisma.user.findUniqueOrThrow({ where: { id: r.userId }, select: { email: true } });
    expect(made.email).toBe(trusted);
  });
});

// The migration's backfill, run exactly as written, inside a transaction that is
// rolled back so the shared database is untouched.
const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20261112150000_bind_signin_identities/migration.sql",
);
function backfillStatements(): string[] {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const m = sql.match(/-- backfill:begin[^\n]*\n([\s\S]*?)-- backfill:end/);
  if (!m) throw new Error("backfill markers missing from the migration");
  return m[1]
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}
async function afterBackfill<T>(read: (tx: typeof prisma) => Promise<T>): Promise<T> {
  try {
    await prisma.$transaction(async (tx) => {
      for (const stmt of backfillStatements()) await tx.$executeRawUnsafe(stmt);
      throw new Rollback(await read(tx as unknown as typeof prisma));
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error("unreachable");
}

describe("the backfill flags only accounts an IdP plainly made", () => {
  const T0 = new Date("2026-01-01T00:00:00Z");
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const HOUR = 3_600_000;
  const fx: Record<string, string> = {};

  beforeAll(async () => {
    const mk = async (tag: string, data: Record<string, unknown>, bindAt?: Date) => {
      const id = await mkUser(`bf-${tag}-${stamp}@${ORG_DOMAIN}`, { createdAt: T0, ...data });
      if (bindAt) {
        await prisma.federatedIdentity.create({
          data: { userId: id, idpConnId: conn.id, subject: `bf-${tag}-${stamp}`, createdAt: bindAt },
        });
      }
      fx[tag] = id;
    };
    // Made by an IdP: bound within a second of creation, and no credential of its own.
    await mk("jit", {}, at(50));
    // Bound within the minute, but the account has a first-party credential, so
    // its owner may have made it: a Google sign-up linked to SSO 30 seconds
    // later, and an email-and-password invitee (the invitation creates the
    // account with a password) linked 20 seconds later.
    await mk("googleThenLinked", { googleId: `bf-g-${stamp}` }, at(30_000));
    await mk("invitedPassword", { passwordHash: hashPassword("i".repeat(12)), passwordSetAt: at(0) }, at(20_000));
    await mk("microsoftThenLinked", {}, at(1000));
    await prisma.microsoftIdentity.create({
      data: { userId: fx.microsoftThenLinked, tenantId: crypto.randomUUID(), objectId: crypto.randomUUID() },
    });
    // An IdP-made account that later gained a password (an SSO session could have
    // set it). Not flagged as IdP-made, but its password is distrusted below.
    await mk("jitThenPassword", { passwordHash: hashPassword("p".repeat(12)), passwordSetAt: at(HOUR) }, at(1000));
    // A first-party account linked to an IdP a day later, password set before that.
    await mk("linkedAfterPassword", { passwordHash: hashPassword("q".repeat(12)), passwordSetAt: at(0) }, at(24 * HOUR));
    // Linked a day later, then a password appeared: an SSO session could have set it.
    await mk("passwordAfterLink", { passwordHash: hashPassword("r".repeat(12)), passwordSetAt: at(48 * HOUR) }, at(24 * HOUR));
    // No IdP at all.
    await mk("plain", { passwordHash: hashPassword("s".repeat(12)), passwordSetAt: at(HOUR) });
  });

  it("flags an account bound at creation that has no credential of its own, and no other", async () => {
    const rows = await afterBackfill((tx) =>
      tx.$queryRawUnsafe<{ id: string; sso_provisioned: boolean }[]>(
        `SELECT id::text, sso_provisioned FROM users WHERE id = ANY($1::uuid[])`,
        Object.values(fx),
      ),
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r.sso_provisioned]));
    expect(by[fx.jit]).toBe(true);
    expect(by[fx.googleThenLinked]).toBe(false);
    expect(by[fx.invitedPassword]).toBe(false);
    expect(by[fx.microsoftThenLinked]).toBe(false);
    expect(by[fx.jitThenPassword]).toBe(false);
    expect(by[fx.linkedAfterPassword]).toBe(false);
    expect(by[fx.passwordAfterLink]).toBe(false);
    expect(by[fx.plain]).toBe(false);
  });

  it("distrusts a password that appeared after an IdP binding", async () => {
    const rows = await afterBackfill((tx) =>
      tx.$queryRawUnsafe<{ id: string; password_untrusted: boolean }[]>(
        `SELECT id::text, password_untrusted FROM users WHERE id = ANY($1::uuid[])`,
        Object.values(fx),
      ),
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r.password_untrusted]));
    expect(by[fx.passwordAfterLink]).toBe(true);
    expect(by[fx.jitThenPassword]).toBe(true);
    expect(by[fx.linkedAfterPassword]).toBe(false);
    expect(by[fx.invitedPassword]).toBe(false);
    expect(by[fx.plain]).toBe(false);
  });
});

describe("an instance admin can clear the IdP-made flag, and the clear is audited", () => {
  let other = { id: "" };
  beforeAll(async () => {
    other = await prisma.organization.create({ data: { name: `prov2 ${stamp}`, slug: `prov2-${stamp}` }, select: { id: true } });
  });
  afterAll(async () => {
    await prismaUnfiltered.orgMember.deleteMany({ where: { orgId: other.id } });
    await prisma.organization.deleteMany({ where: { id: other.id } }).catch(() => undefined);
  });

  const clear = (userId: string) =>
    clearFlag(new Request(`http://localhost/api/v1/admin/sso-provisioned/${userId}`, { method: "DELETE" }), {
      params: Promise.resolve({ userId }),
    });
  const flagOf = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id }, select: { ssoProvisioned: true } })).ssoProvisioned;

  it("refuses anyone who isn't an instance admin, and leaves the flag set", async () => {
    const flagged = await mkUser(`fl-a-${stamp}@${ORG_DOMAIN}`, { ssoProvisioned: true });
    const member = await mkUser(`not-admin-${stamp}@example.com`, { googleId: `g-na-${stamp}` });
    await signIn(member, { authMethod: "google" });
    expect((await listFlagged()).status).toBe(403);
    expect((await clear(flagged)).status).toBe(403);
    expect(await flagOf(flagged)).toBe(true);
  });

  it("lists flagged accounts and clears one, auditing it in the IdP's org and in every org it belongs to, removed ones too", async () => {
    const flagged = await mkUser(`fl-b-${stamp}@${ORG_DOMAIN}`, { ssoProvisioned: true });
    const unflagged = await mkUser(`fl-c-${stamp}@${ORG_DOMAIN}`);
    await prisma.federatedIdentity.create({ data: { userId: flagged, idpConnId: conn.id, subject: `s-fl-${stamp}`, issuer: ISSUER } });
    await prismaUnfiltered.orgMember.create({ data: { orgId: other.id, userId: flagged, removedAt: new Date() } });

    const admin = await mkUser(adminAddress("ops"), { googleId: `g-ops-${stamp}` });
    await signIn(admin, { authMethod: "google" });

    const listed = (await (await listFlagged()).json()) as { id: string }[];
    expect(listed.map((a) => a.id)).toContain(flagged);
    expect(listed.map((a) => a.id)).not.toContain(unflagged);

    expect((await clear(flagged)).status).toBe(204);
    expect(await flagOf(flagged)).toBe(false);
    const audit = await prisma.auditLog.findMany({
      where: { action: "auth.sso_provisioned.cleared", entityId: flagged },
      select: { orgId: true, userId: true },
    });
    expect(audit.map((a) => a.orgId).sort()).toEqual([org.id, other.id].sort());
    expect(audit.every((a) => a.userId === admin)).toBe(true);

    // Nothing left to clear: says so, and writes nothing more.
    expect((await clear(flagged)).status).toBe(404);
    expect((await clear(unflagged)).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: "auth.sso_provisioned.cleared", entityId: flagged } })).toBe(2);
  });
});
