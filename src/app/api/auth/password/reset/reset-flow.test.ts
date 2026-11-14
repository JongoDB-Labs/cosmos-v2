// @vitest-environment node
//
// End-to-end self-service password reset, driven through the REAL request +
// confirm route handlers and the REAL e2e DB. Only the rate limiter and the
// transactional-email send are stubbed (the send is captured so the test can
// pull the signed reset link back out and complete the flow). Proves:
//   - forgot-password emails a single-use, policy-respecting reset link;
//   - completing it sets a new password the user can verify, clears
//     mustChangePassword, and the SAME link can't be reused (single-use);
//   - SSO/Google-only accounts and unknown emails get NO mail (no enumeration).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";

// Vault key for sealing/opening the reset token.
process.env.SSO_VAULT_KEY = Buffer.alloc(32, 21).toString("base64");

vi.mock("@/lib/rate-limit/bucket", () => ({
  rateLimit: () => ({ allowed: true }),
}));

// Capture reset emails instead of hitting Resend; expose the last reset URL.
const sentEmails: { orgId?: string; toEmail: string; resetUrl: string }[] = [];
vi.mock("@/lib/integrations/invitation-email", () => ({
  sendPasswordResetEmail: vi.fn(async (p: { orgId?: string; toEmail: string; resetUrl: string }) => {
    sentEmails.push(p);
  }),
}));

import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createPasswordResetToken, parsePasswordResetToken } from "@/lib/auth/password-reset";
import { POST as requestReset } from "./request/route";
import { maskEmail } from "@/lib/auth/mask-email";
import { POST as confirmReset } from "./confirm/route";

const E_PW = "zz-reset-pw@example.com";
const E_SSO = "zz-reset-sso@example.com";
const OLD_PASSWORD = "old-passphrase-1234";
const NEW_PASSWORD = "brand-new-reset-9x!";

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/password/reset", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function tokenFrom(resetUrl: string): string {
  const t = new URL(resetUrl).searchParams.get("token");
  if (!t) throw new Error("no token in reset URL");
  return t;
}

async function cleanup() {
  const emails = [E_PW, E_SSO];
  await prisma.session.deleteMany({ where: { user: { email: { in: emails } } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.user.create({
    data: {
      email: E_PW,
      displayName: "Reset PW",
      passwordHash: hashPassword(OLD_PASSWORD),
      passwordSetAt: new Date(),
      mustChangePassword: true,
    },
  });
  // SSO/Google-only account — no passwordHash.
  await prisma.user.create({
    data: { email: E_SSO, displayName: "Reset SSO", googleId: "zz-reset-sso-gid" },
  });
});
afterAll(cleanup);

describe("self-service password reset", () => {
  it("emails a reset link, sets a new password, clears mustChangePassword, and is single-use", async () => {
    sentEmails.length = 0;
    const res = await requestReset(req({ email: E_PW }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].toEmail).toBe(E_PW);

    const token = tokenFrom(sentEmails[0].resetUrl);

    // Policy is enforced: too-short password is rejected.
    const short = await confirmReset(req({ token, newPassword: "short" }));
    expect(short.status).toBe(400);

    // Complete the reset.
    const done = await confirmReset(req({ token, newPassword: NEW_PASSWORD }));
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true });

    const user = await prisma.user.findFirstOrThrow({ where: { email: E_PW } });
    expect(user.mustChangePassword).toBe(false);
    expect(verifyPassword(NEW_PASSWORD, user.passwordHash!)).toBe(true);
    expect(verifyPassword(OLD_PASSWORD, user.passwordHash!)).toBe(false);

    // Single-use: the same link can't be replayed (fingerprint moved on).
    const replay = await confirmReset(req({ token, newPassword: "another-passphrase-77" }));
    expect(replay.status).toBe(400);
  });

  // A reset is what you do when someone else may have your password, so it
  // must end every sign-in the account had, not just change the password.
  it("ends every session the account had, and no one else's", async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: E_PW } });
    const sso = await prisma.user.findFirstOrThrow({ where: { email: E_SSO } });
    const expiresAt = new Date(Date.now() + 86_400_000);
    await prisma.session.create({ data: { id: `zz-reset-a-${user.id}`, userId: user.id, expiresAt } });
    await prisma.session.create({ data: { id: `zz-reset-b-${user.id}`, userId: user.id, expiresAt } });
    await prisma.session.create({ data: { id: `zz-reset-c-${sso.id}`, userId: sso.id, expiresAt } });

    sentEmails.length = 0;
    await requestReset(req({ email: E_PW }));
    const token = tokenFrom(sentEmails[0].resetUrl);
    // Positive control: the sessions are really there before the reset.
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);

    const done = await confirmReset(req({ token, newPassword: "third-passphrase-42" }));
    expect(done.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: sso.id } })).toBe(1);
  });

  it("sends NO mail for an SSO/Google-only account (nothing to reset)", async () => {
    sentEmails.length = 0;
    const res = await requestReset(req({ email: E_SSO }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentEmails).toHaveLength(0);
  });

  it("sends NO mail for an unknown email but still returns the generic OK", async () => {
    sentEmails.length = 0;
    const res = await requestReset(req({ email: "zz-nobody-here@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentEmails).toHaveLength(0);
  });

  it("rejects a malformed/garbage token at confirm", async () => {
    const res = await confirmReset(req({ token: "garbage", newPassword: NEW_PASSWORD }));
    expect(res.status).toBe(400);
  });
});

/**
 * The outcome trail. Before this, the route logged ONLY on send failure, so an
 * absent signal meant "mail went out", "no account matched" and "nobody ever
 * submitted" equally well — a member reported a reset that never arrived and
 * there was no way to tell which had happened. These pin each outcome to a
 * durable, org-scoped audit row.
 *
 * Each case needs a real org: AuditLog.orgId is NOT nullable, so a requester
 * who resolves no org at all is covered by the operator log line alone (the
 * users in the suite above are deliberately org-less, which is why they assert
 * mail rather than audit rows).
 */
describe("self-service password reset leaves an outcome trail", () => {
  const stamp = Date.now().toString(36);
  const slug = `zzpwr-${stamp}`;
  const E_MEMBER = `zz-pwr-member-${stamp}@example.com`;
  const E_MEMBER_SSO = `zz-pwr-sso-${stamp}@example.com`;
  const E_INVITED = `zz-pwr-invited-${stamp}@example.com`;
  let orgId = "";

  async function outcomeOf(action: string): Promise<Record<string, unknown>> {
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { orgId, action },
      orderBy: { createdAt: "desc" },
    });
    return row.metadata as Record<string, unknown>;
  }

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: `pwr ${stamp}`, slug } })
    ).id;
    for (const [email, extra] of [
      [E_MEMBER, { passwordHash: hashPassword(OLD_PASSWORD), passwordSetAt: new Date() }],
      [E_MEMBER_SSO, { googleId: `zz-pwr-gid-${stamp}` }],
    ] as const) {
      const u = await prisma.user.create({
        data: { email: email as string, displayName: "PWR", ...extra },
      });
      await prisma.orgMember.create({
        data: { orgId, userId: u.id, role: "MEMBER", permissions: "0" },
      });
    }
    // Invited but never joined: no account, but the org that courted them is
    // still the right one to attribute the attempt to.
    await prisma.invitation.create({
      data: {
        orgId,
        email: E_INVITED,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  });

  it("records `sent` — a success signal, which is what makes its absence mean something", async () => {
    sentEmails.length = 0;
    expect((await requestReset(req({ email: E_MEMBER }))).status).toBe(200);
    expect(sentEmails).toHaveLength(1);

    const meta = await outcomeOf("auth.password_reset.requested");
    expect(meta.outcome).toBe("sent");
    expect(meta.email).toBe(E_MEMBER);
  });

  it("names `sso_only` instead of going silent — the outcome most often reported as broken", async () => {
    sentEmails.length = 0;
    expect((await requestReset(req({ email: E_MEMBER_SSO }))).status).toBe(200);
    // Still no mail, and still the same generic body: the trail is for the
    // operator, never the caller.
    expect(sentEmails).toHaveLength(0);

    const meta = await outcomeOf("auth.password_reset.requested");
    expect(meta.outcome).toBe("sso_only");
  });

  it("writes NO tenant row for an invited address that is not a member", async () => {
    // An invited-but-not-joined address resolves an org only through the
    // pending-invitation fallback. That is the right org to send mail AS and
    // the wrong basis for a tenant-readable audit row: the address may already
    // have an account elsewhere, so attributing its outcome to the inviting
    // org would put a non-member's state into that org's log. The operator
    // line still records it, so nothing diagnostic is lost.
    sentEmails.length = 0;
    const before = await prisma.auditLog.count({ where: { orgId } });
    expect((await requestReset(req({ email: E_INVITED }))).status).toBe(200);
    expect(sentEmails).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { orgId } })).toBe(before);
  });

  it("records the completed reset as its own action, so 'asked for' and 'used' are distinguishable", async () => {
    sentEmails.length = 0;
    await requestReset(req({ email: E_MEMBER }));
    const token = tokenFrom(sentEmails[0].resetUrl);

    const done = await confirmReset(req({ token, newPassword: NEW_PASSWORD }));
    expect(done.status).toBe(200);

    const meta = await outcomeOf("auth.password_reset.completed");
    expect(meta.email).toBe(E_MEMBER);
    // Distinct from the request action: a request that nobody completes is
    // exactly the state this pair exists to make visible.
    expect(
      await prisma.auditLog.count({
        where: { orgId, action: "auth.password_reset.completed" },
      }),
    ).toBe(1);
  });

  it("still mails the eligible account when an INELIGIBLE row shares the address", async () => {
    // `User.email` has no unique constraint, so one address can match several
    // rows -- e.g. a deactivated row kept for attribution alongside a current
    // one. Diagnosing the outcome from an unfiltered lookup let the ineligible
    // row win and refused a reset to a good account. The ineligible row is
    // created FIRST so an unordered findFirst would reach it first.
    const dupe = `zz-pwr-dupe-${stamp}@example.com`;
    const dead = await prisma.user.create({
      data: {
        email: dupe,
        displayName: "PWR dead",
        passwordHash: hashPassword(OLD_PASSWORD),
        passwordSetAt: new Date(),
        deactivatedAt: new Date(),
      },
    });
    await prisma.orgMember.create({
      data: { orgId, userId: dead.id, role: "MEMBER", permissions: "0" },
    });
    const live = await prisma.user.create({
      data: {
        email: dupe,
        displayName: "PWR live",
        passwordHash: hashPassword(OLD_PASSWORD),
        passwordSetAt: new Date(),
      },
    });
    await prisma.orgMember.create({
      data: { orgId, userId: live.id, role: "MEMBER", permissions: "0" },
    });

    sentEmails.length = 0;
    expect((await requestReset(req({ email: dupe }))).status).toBe(200);
    expect(sentEmails).toHaveLength(1);

    const meta = await outcomeOf("auth.password_reset.requested");
    expect(meta.outcome).toBe("sent");

    // Both rows carry the SAME address, so asserting the email proves nothing
    // about WHICH account was mailed -- the token has to be decoded. Without
    // this the spec passed against the very bug it exists to catch.
    const decoded = parsePasswordResetToken(tokenFrom(sentEmails[0].resetUrl));
    expect(decoded?.uid).toBe(live.id);
    expect(decoded?.uid).not.toBe(dead.id);
  });

  it("a reset for an address with no account and no invitation writes no row, and still returns OK", async () => {
    sentEmails.length = 0;
    const before = await prisma.auditLog.count({ where: { orgId } });
    const res = await requestReset(req({ email: `zz-pwr-nowhere-${stamp}@example.com` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentEmails).toHaveLength(0);
    // Nowhere to attribute it: no membership, no pending invitation.
    expect(await prisma.auditLog.count({ where: { orgId } })).toBe(before);
  });
});

/**
 * Each org's admins answer "did anyone reset this person's password?" from
 * their own audit log, so the completed reset is recorded in EVERY org the
 * account belongs to. It used to go to the first membership only, which left
 * every other org blind. An org the person was removed from gets no row: the
 * membership is kept for history, and a nested membership read does not hide
 * it the way a direct orgMember query does.
 */
describe("a completed reset is recorded in every organization the account belongs to", () => {
  const stamp = Math.random().toString(36).slice(2, 8);
  const email = `zz-pwr-multi-${stamp}@example.com`;
  const orgs = { removed: "", first: "", second: "" };
  let userId = "";

  beforeAll(async () => {
    userId = (
      await prisma.user.create({
        data: { email, displayName: "PWR multi", passwordHash: hashPassword(OLD_PASSWORD), passwordSetAt: new Date() },
      })
    ).id;
    // The removed membership is created first, so a read that keeps it in
    // order would reach it first.
    for (const which of ["removed", "first", "second"] as const) {
      const orgId = (
        await prisma.organization.create({ data: { name: `pwr ${which} ${stamp}`, slug: `zzpwm-${which}-${stamp}` } })
      ).id;
      orgs[which] = orgId;
      await prisma.orgMember.create({
        data: { orgId, userId, role: "MEMBER", permissions: "0", ...(which === "removed" ? { removedAt: new Date() } : {}) },
      });
    }
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: Object.values(orgs) } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  });

  it("writes auth.password_reset.completed in each active org, and none in the org they left", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const token = createPasswordResetToken(user);
    expect((await confirmReset(req({ token, newPassword: NEW_PASSWORD }))).status).toBe(200);

    const completed = async (orgId: string) =>
      prisma.auditLog.count({ where: { orgId, action: "auth.password_reset.completed", entityId: userId } });
    expect({
      first: await completed(orgs.first),
      second: await completed(orgs.second),
      removed: await completed(orgs.removed),
    }).toEqual({ first: 1, second: 1, removed: 0 });
  });
});

/**
 * A reset REQUEST picks the org whose mail settings send the link, and writes
 * its outcome to that org's audit log. An org the person was removed from is
 * neither: the membership is kept for history, and a nested membership read
 * does not hide it the way a direct orgMember query does.
 */
describe("a reset request never mails as, or audits into, an org the person left", () => {
  const stamp = Math.random().toString(36).slice(2, 8);
  const orgIds: string[] = [];
  const userIds: string[] = [];

  async function org(label: string) {
    const o = await prisma.organization.create({ data: { name: `pwq ${label} ${stamp}`, slug: `zzpwq-${label}-${stamp}` } });
    orgIds.push(o.id);
    return o;
  }
  async function account(label: string, withPassword: boolean, memberships: { orgId: string; removed: boolean }[]) {
    const email = `zz-pwq-${label}-${stamp}@example.com`;
    const u = await prisma.user.create({
      data: withPassword
        ? { email, displayName: "PWQ", passwordHash: hashPassword(OLD_PASSWORD), passwordSetAt: new Date() }
        : { email, displayName: "PWQ", googleId: `zz-pwq-gid-${label}-${stamp}` },
    });
    userIds.push(u.id);
    // In the order given: the removed membership first, so a read that keeps it reaches it first.
    for (const m of memberships) {
      await prisma.orgMember.create({
        data: { orgId: m.orgId, userId: u.id, role: "MEMBER", permissions: "0", ...(m.removed ? { removedAt: new Date() } : {}) },
      });
    }
    return email;
  }
  const requested = (orgId: string) => prisma.auditLog.count({ where: { orgId, action: "auth.password_reset.requested" } });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  });

  it("uses the org they still belong to, even when the login screen names the one they left", async () => {
    const left = await org("left");
    const kept = await org("kept");
    const email = await account("both", true, [{ orgId: left.id, removed: true }, { orgId: kept.id, removed: false }]);

    for (const body of [{ email }, { email, orgSlug: left.slug }]) {
      sentEmails.length = 0;
      expect((await requestReset(req(body))).status).toBe(200);
      expect(sentEmails.map((m) => m.orgId)).toEqual([kept.id]);
    }
    expect(await requested(kept.id)).toBe(2);
    expect(await requested(left.id)).toBe(0);
  });

  it("someone removed from their only org still gets the link, sent as no org, and that org records nothing", async () => {
    const left = await org("only");
    const email = await account("only", true, [{ orgId: left.id, removed: true }]);
    sentEmails.length = 0;
    expect((await requestReset(req({ email }))).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].orgId).toBeUndefined();
    expect(await requested(left.id)).toBe(0);
  });

  it("an account with no password, removed from its only org, leaves no record there either", async () => {
    // The no-mail outcomes are attributed through the same membership read.
    const left = await org("sso");
    const email = await account("sso", false, [{ orgId: left.id, removed: true }]);
    sentEmails.length = 0;
    expect((await requestReset(req({ email }))).status).toBe(200);
    expect(sentEmails).toHaveLength(0);
    expect(await requested(left.id)).toBe(0);
  });
});

describe("maskEmail keeps an unmatched address out of the operator log", () => {
  it("leaves one letter and the domain — correlatable, not a copy of the address", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
  });

  it("masks the local part even when it contains an @-like string", () => {
    // Split on the LAST @, so a quoted local part can't leak through.
    expect(maskEmail('"weird@inner"@example.com')).toBe('"***@example.com');
  });

  it("never returns the input when there is no usable local part", () => {
    for (const bad of ["@example.com", "nope", ""]) {
      expect(maskEmail(bad)).toBe("***");
    }
  });
});
