// @vitest-environment node
//
// ACCEPTANCE — needs a real Postgres, so it is deliberately outside the hermetic
// `npm test` run. Invoke explicitly:
//   DATABASE_URL=... npx vitest run --config vitest.acceptance.config.ts
//
// What it proves is the thing the unit mocks structurally cannot: that revoking
// an email/password invitation leaves the address genuinely re-invitable against
// a real database.
//
// The bug: revoke deleted the invitation and left the User it had provisioned.
// provisionEmailPasswordInvite refuses to touch a pre-existing account, so the
// create route coerced the second invite to "oauth" and issued NO password. The
// invitee got a sign-in link for a credential that had just been revoked. Every
// layer reported success; the address was simply finished.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";
import { provisionEmailPasswordInvite } from "@/lib/auth/invite-credentials";
import { revokeProvisionedAccount } from "@/lib/auth/revoke-invitation";

const ORG = "5f000000-0000-4000-8000-0000000000a1";
const EMAIL = "revoke-cycle@acceptance.invalid";
const MEMBER_EMAIL = "revoke-member@acceptance.invalid";

/** What the route does, in the same order and the same transaction. */
async function revoke(email: string, invitationId: string, signInMethod = "email_password") {
  return prisma.$transaction(async (tx) => {
    const outcome = await revokeProvisionedAccount(tx, { email, invitationId, signInMethod });
    await tx.invitation.delete({ where: { id: invitationId } });
    return outcome;
  });
}

async function invite(email: string) {
  return prisma.$transaction(async (tx) => {
    const provisioned = await provisionEmailPasswordInvite({ email, mfaRequired: false, client: tx });
    const inv = await tx.invitation.create({
      data: {
        orgId: ORG,
        email,
        role: "MEMBER",
        signInMethod: "email_password",
        expiresAt: new Date(Date.now() + 7 * 864e5),
      },
      select: { id: true },
    });
    return { invitationId: inv.id, ...provisioned };
  });
}

const wipe = async () => {
  const emails = [EMAIL, MEMBER_EMAIL];
  await prisma.invitation.deleteMany({ where: { email: { in: emails } } });
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.orgMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
};

beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: "Revoke Cycle Test", slug: "revoke-cycle-test" },
    update: {},
  });
  await wipe();
});
afterAll(wipe);

describe("revoking an invitation frees the address", () => {
  it("lets the same address be invited again, with a real password", async () => {
    const first = await invite(EMAIL);
    expect(first.tempPassword).toBeTruthy();

    const outcome = await revoke(EMAIL, first.invitationId);
    expect(outcome.deleted).toBe(true);

    // The account is gone, not merely detached.
    expect(await prisma.user.findFirst({ where: { email: EMAIL } })).toBeNull();

    // The whole point: this call is what threw ConflictError before the fix,
    // which is why the route silently downgraded the re-invite to OAuth.
    const second = await invite(EMAIL);
    expect(second.tempPassword).toBeTruthy();
    expect(second.tempPassword).not.toBe(first.tempPassword);
    expect(second.userId).not.toBe(first.userId);

    await revoke(EMAIL, second.invitationId);
  });

  it("matches the address case-insensitively", async () => {
    const { invitationId } = await invite(EMAIL);
    // Revoke via a differently-cased address — a cased row must not survive.
    const outcome = await revoke(EMAIL.toUpperCase(), invitationId);
    expect(outcome.deleted).toBe(true);
    expect(await prisma.user.findFirst({ where: { email: EMAIL } })).toBeNull();
  });
});

describe("but never deletes an account a person is behind", () => {
  it("leaves an account that has joined an organisation", async () => {
    const { invitationId, userId } = await invite(MEMBER_EMAIL);
    // They accepted: the membership is the whole difference.
    await prisma.orgMember.create({ data: { orgId: ORG, userId, role: "MEMBER" } });

    const outcome = await revoke(MEMBER_EMAIL, invitationId);
    expect(outcome.deleted).toBe(false);
    expect(outcome.reason).toMatch(/organisation/i);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();

    // And the invitation is gone regardless — revoke still revokes.
    expect(await prisma.invitation.findUnique({ where: { id: invitationId } })).toBeNull();
  });
});
