// @vitest-environment node
//
// deleteUserAccount — the anonymize + revoke-all-access core of platform-admin
// account deletion. DB-free: prisma.$transaction is mocked to run the callback
// against a fake tx client. Proves:
//   - every access/identity grant is deleted (sessions, memberships, federated
//     identities, push subs) + the email's allowlist rows and pending invitations
//     (matched case-insensitively);
//   - the User row is anonymized in place: email rewritten to a per-user sentinel
//     (freeing the original), credentials + MFA wiped, deactivatedAt stamped;
//   - authored content is NOT touched (no work-item / comment / note deletes);
//   - it returns the revocation counts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, tx } = vi.hoisted(() => {
  const tx = {
    session: { deleteMany: vi.fn() },
    orgMember: { deleteMany: vi.fn() },
    federatedIdentity: { deleteMany: vi.fn() },
    pushSubscription: { deleteMany: vi.fn() },
    allowedEmail: { deleteMany: vi.fn() },
    invitation: { deleteMany: vi.fn() },
    user: { update: vi.fn() },
  };
  return {
    tx,
    prisma: { $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)) },
  };
});
vi.mock("@/lib/db/client", () => ({ prisma }));

import { deleteUserAccount } from "./delete-user";

const USER_ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  tx.session.deleteMany.mockResolvedValue({ count: 2 });
  tx.orgMember.deleteMany.mockResolvedValue({ count: 3 });
  tx.federatedIdentity.deleteMany.mockResolvedValue({ count: 1 });
  tx.pushSubscription.deleteMany.mockResolvedValue({ count: 4 });
  tx.allowedEmail.deleteMany.mockResolvedValue({ count: 1 });
  tx.invitation.deleteMany.mockResolvedValue({ count: 2 });
  tx.user.update.mockResolvedValue({ id: USER_ID });
});

describe("deleteUserAccount — revokes every access + identity grant", () => {
  it("deletes sessions, memberships, federated identities and push subs by userId", async () => {
    await deleteUserAccount({ userId: USER_ID, email: "Person@Example.com" });

    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(tx.orgMember.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(tx.federatedIdentity.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(tx.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it("deletes allowlist rows + pending invitations for the email, case-insensitively", async () => {
    await deleteUserAccount({ userId: USER_ID, email: "Person@Example.com" });

    const insensitive = { email: { equals: "person@example.com", mode: "insensitive" } };
    expect(tx.allowedEmail.deleteMany).toHaveBeenCalledWith({ where: insensitive });
    expect(tx.invitation.deleteMany).toHaveBeenCalledWith({ where: insensitive });
  });
});

describe("deleteUserAccount — anonymizes the account + frees the email", () => {
  it("rewrites the email to a unique sentinel, wipes credentials, stamps deactivatedAt", async () => {
    await deleteUserAccount({ userId: USER_ID, email: "person@example.com" });

    expect(tx.user.update).toHaveBeenCalledTimes(1);
    const call = tx.user.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: USER_ID });
    const data = call.data;
    // Email is freed by rewriting to a per-user, unroutable sentinel.
    expect(data.email).toBe(`deleted-${USER_ID}@deleted.invalid`);
    expect(data.email).not.toBe("person@example.com");
    expect(data.displayName).toBe("Deleted user");
    // Every sign-in path is broken.
    expect(data.passwordHash).toBeNull();
    expect(data.googleId).toBeNull();
    expect(data.auth0UserId).toBeNull();
    expect(data.mfaSecret).toBeNull();
    expect(data.mfaEnabled).toBe(false);
    expect(data.mustChangePassword).toBe(false);
    expect(data.mfaRecoveryCodes).toEqual([]);
    expect(data.deactivatedAt).toBeInstanceOf(Date);
  });

  it("does NOT delete authored content (no work-item / comment / note writes)", async () => {
    await deleteUserAccount({ userId: USER_ID, email: "person@example.com" });
    // The fake tx only exposes the revoke targets; assert we never reached for
    // an authored-content model (would be undefined on tx and throw if called).
    expect((tx as Record<string, unknown>).workItem).toBeUndefined();
    expect((tx as Record<string, unknown>).comment).toBeUndefined();
    expect((tx as Record<string, unknown>).note).toBeUndefined();
  });

  it("returns the revocation counts", async () => {
    const res = await deleteUserAccount({ userId: USER_ID, email: "person@example.com" });
    expect(res).toMatchObject({
      userId: USER_ID,
      originalEmail: "person@example.com",
      sentinelEmail: `deleted-${USER_ID}@deleted.invalid`,
      sessionsRevoked: 2,
      membershipsRemoved: 3,
      federatedIdentitiesRemoved: 1,
      pushSubscriptionsRemoved: 4,
      allowlistEntriesRemoved: 1,
      invitationsRemoved: 2,
    });
  });
});
