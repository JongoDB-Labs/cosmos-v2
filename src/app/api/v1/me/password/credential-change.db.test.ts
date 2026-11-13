// @vitest-environment node
//
// Changing your own credentials must end every OTHER sign-in: if someone else
// is holding one of your sessions, changing your password or turning off MFA is
// what you do about it, and it did nothing to their session. The session making
// the change stays signed in. Each change also leaves an audit row in the orgs
// you belong to.
//
// A session alone also must not set a FIRST password on an account that signs
// in only through Google or SSO: that turns a stolen session cookie into a
// permanent way in that the identity provider can't revoke. Setting one needs a
// recent sign-in. Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/totp";

const h = vi.hoisted(() => ({ userId: "", sessionId: "" }));
// The real session lookup, for the session this test says is current: whether a
// first password may be set depends on how that session signed in.
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...real, getCurrentUser: async () => real.getSessionUser(h.sessionId) };
});

import { POST as changePassword } from "./route";
import { POST as disableMfa } from "../mfa/disable/route";

const stamp = Math.random().toString(36).slice(2, 8);
const OLD = "old-passphrase-1234";
const NEW = "new-passphrase-5678!";
const DAY = 86_400_000;
let orgId = "", bystanderId = "";
const users: string[] = [];

const post = (handler: (r: NextRequest) => Promise<Response>, body: unknown) =>
  handler(
    new NextRequest("http://localhost/x", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

/** A user in the org with a current session (the caller) and another one. */
async function userWithTwoSessions(
  tag: string,
  data: Record<string, unknown>,
  currentAgeMs = 0,
  authMethod: string | null = null,
) {
  const u = await prisma.user.create({
    data: { email: `cc-${tag}-${stamp}@example.com`, displayName: tag, ...data },
  });
  users.push(u.id);
  await prisma.orgMember.create({ data: { orgId, userId: u.id, role: "MEMBER", permissions: "0" } });
  const current = `cc-${tag}-current-${stamp}`;
  const other = `cc-${tag}-other-${stamp}`;
  const expiresAt = new Date(Date.now() + DAY);
  await prisma.session.create({
    data: { id: current, userId: u.id, expiresAt, createdAt: new Date(Date.now() - currentAgeMs), authMethod },
  });
  await prisma.session.create({ data: { id: other, userId: u.id, expiresAt } });
  // The org's Sessions view had recorded the other one.
  await prisma.sessionRecord.create({ data: { orgId, userId: u.id, sessionToken: other, expiresAt } });
  h.userId = u.id;
  h.sessionId = current;
  return { id: u.id, current, other };
}

const alive = async (id: string) => (await prisma.session.findUnique({ where: { id } })) !== null;
const auditRows = (userId: string, action: string) =>
  prisma.auditLog.count({ where: { orgId, userId, action } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `cc ${stamp}`, slug: `cc-${stamp}` } })).id;
  // Someone else's session, which no change here may touch.
  bystanderId = (await prisma.user.create({ data: { email: `cc-by-${stamp}@example.com`, displayName: "By" } })).id;
  users.push(bystanderId);
  await prisma.session.create({ data: { id: `cc-by-${stamp}`, userId: bystanderId, expiresAt: new Date(Date.now() + DAY) } });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

describe("changing your password", () => {
  it("ends your other sessions, keeps this one, and is audited", async () => {
    const u = await userWithTwoSessions("chg", { passwordHash: hashPassword(OLD), passwordSetAt: new Date() });
    const res = await post(changePassword, { currentPassword: OLD, newPassword: NEW });
    expect(res.status).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(verifyPassword(NEW, row.passwordHash!)).toBe(true);
    expect(await alive(u.current)).toBe(true);
    expect(await alive(u.other)).toBe(false);
    expect(await alive(`cc-by-${stamp}`)).toBe(true);
    const rec = await prisma.sessionRecord.findUniqueOrThrow({ where: { sessionToken: u.other } });
    expect(rec.status).toBe("REVOKED");
    expect(await auditRows(u.id, "auth.password.changed")).toBe(1);
  });

  it("positive control: a wrong current password changes nothing and ends nothing", async () => {
    const u = await userWithTwoSessions("wrong", { passwordHash: hashPassword(OLD), passwordSetAt: new Date() });
    const res = await post(changePassword, { currentPassword: "not-it-at-all-1", newPassword: NEW });
    expect(res.status).toBe(403);
    expect(await alive(u.other)).toBe(true);
    expect(await auditRows(u.id, "auth.password.changed")).toBe(0);
  });
});

describe("setting a first password on a Google or SSO account", () => {
  it("is refused from a session that signed in a while ago", async () => {
    const u = await userWithTwoSessions("stale", { googleId: `cc-gid-stale-${stamp}` }, 60 * 60_000, "google");
    const res = await post(changePassword, { newPassword: NEW });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/sign in again/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.passwordHash).toBeNull();
    expect(await alive(u.other)).toBe(true);
  });

  it("works right after signing in, and ends your other sessions", async () => {
    const u = await userWithTwoSessions("fresh", { googleId: `cc-gid-fresh-${stamp}` }, 60_000, "google");
    const res = await post(changePassword, { newPassword: NEW });
    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(verifyPassword(NEW, row.passwordHash!)).toBe(true);
    expect(await alive(u.current)).toBe(true);
    expect(await alive(u.other)).toBe(false);
    expect(await auditRows(u.id, "auth.password.set")).toBe(1);
  });
});

describe("turning off MFA", () => {
  it("ends your other sessions, keeps this one, and is audited", async () => {
    const [code] = generateRecoveryCodes(1);
    const u = await userWithTwoSessions("mfa", {
      passwordHash: hashPassword(OLD),
      mfaEnabled: true,
      mfaRecoveryCodes: [hashRecoveryCode(code)],
    });
    const res = await post(disableMfa, { code });
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mfaEnabled).toBe(false);
    expect(await alive(u.current)).toBe(true);
    expect(await alive(u.other)).toBe(false);
    expect(await alive(`cc-by-${stamp}`)).toBe(true);
    expect(await auditRows(u.id, "auth.mfa.disabled")).toBe(1);
  });

  it("positive control: a wrong code leaves MFA on and ends nothing", async () => {
    const [code] = generateRecoveryCodes(1);
    const u = await userWithTwoSessions("mfa-wrong", {
      mfaEnabled: true,
      mfaRecoveryCodes: [hashRecoveryCode(code)],
    });
    const res = await post(disableMfa, { code: "WRONG-0000" });
    expect(res.status).toBe(403);
    expect(await alive(u.other)).toBe(true);
    expect(await auditRows(u.id, "auth.mfa.disabled")).toBe(0);
  });
});
