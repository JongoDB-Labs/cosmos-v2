// @vitest-environment node
//
// Every guard on revokeProvisionedAccount, because it DELETES an account.
//
// The bug it fixes: revoking removed the invitation but left the account it had
// provisioned, so the next invite to that address took the "pre-existing
// account" branch — which deliberately never issues a password. The invitee got
// a sign-in link for credentials nobody had given them.
//
// The risk it introduces is the opposite one, so these tests are mostly about
// what it must REFUSE to delete.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revokeProvisionedAccount } from "../revoke-invitation";

const tx = {
  user: { findFirst: vi.fn(), delete: vi.fn() },
  invitation: { count: vi.fn() },
};

/** An account that IS a pure artifact of the invitation being revoked. */
const disposable = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  lastActiveAt: null,
  mustChangePassword: true,
  googleId: null,
  auth0UserId: null,
  _count: { memberships: 0 },
  ...over,
});

const run = (over: Record<string, unknown> = {}) =>
  revokeProvisionedAccount(tx as never, {
    email: "invitee@example.com",
    invitationId: "inv1",
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  tx.user.findFirst.mockResolvedValue(disposable());
  tx.invitation.count.mockResolvedValue(0);
  tx.user.delete.mockResolvedValue({});
});

describe("deletes only a pure artifact of the invitation", () => {
  it("removes an unused account the invitation provisioned", async () => {
    const out = await run();
    expect(out.deleted).toBe(true);
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: "u1" } });
  });

  it("matches the address case-insensitively", async () => {
    await run();
    expect(tx.user.findFirst.mock.calls[0][0].where.email).toEqual({
      equals: "invitee@example.com",
      mode: "insensitive",
    });
  });
});

describe("frees an account stranded by an earlier revoke", () => {
  it("deletes it even though THIS invitation provisioned nothing", async () => {
    // The real sequence that stayed broken: invite (account created), revoke,
    // re-invite. The second invitation is coerced to "oauth" because the account
    // now exists, so a guard keyed on THIS invitation's signInMethod declined to
    // clean up and the address stayed un-re-invitable forever.
    //
    // Whether this particular invitation issued the credential is not the
    // question. Whether anyone can use the account is, and the guards below
    // answer it.
    const out = await run();
    expect(out.deleted).toBe(true);
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: "u1" } });
  });

  it("never reaches a synthetic bot account", async () => {
    // Bots have no temp password so the guards already exclude them, but the
    // lookup refuses to see them at all -- same as every other credential path.
    await run();
    expect(tx.user.findFirst.mock.calls[0][0].where.isBot).toBe(false);
  });
});

describe("refuses to delete anything that might be a person", () => {
  it("leaves an account that belongs to an organisation", async () => {
    tx.user.findFirst.mockResolvedValue(disposable({ _count: { memberships: 1 } }));
    expect((await run()).deleted).toBe(false);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("leaves an account that has been used", async () => {
    tx.user.findFirst.mockResolvedValue(disposable({ lastActiveAt: new Date() }));
    expect((await run()).deleted).toBe(false);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("leaves an account whose owner set their own password", async () => {
    // mustChangePassword false means they chose it — the credential is theirs,
    // not the one the invite issued.
    tx.user.findFirst.mockResolvedValue(disposable({ mustChangePassword: false }));
    expect((await run()).deleted).toBe(false);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["google", { googleId: "g1" }],
    ["auth0", { auth0UserId: "a1" }],
  ])("leaves an account with a linked %s identity", async (_label, over) => {
    tx.user.findFirst.mockResolvedValue(disposable(over));
    expect((await run()).deleted).toBe(false);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("leaves an account another invitation is still relying on", async () => {
    // A second org invited them too. Deleting here would break that invite.
    tx.invitation.count.mockResolvedValue(1);
    expect((await run()).deleted).toBe(false);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("excludes the invitation being revoked from that count", async () => {
    await run();
    expect(tx.invitation.count.mock.calls[0][0].where.id).toEqual({ not: "inv1" });
  });

  it("is fine when no account exists at all", async () => {
    tx.user.findFirst.mockResolvedValue(null);
    expect((await run()).deleted).toBe(false);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });
});

describe("says why, either way", () => {
  it("gives a reason on refusal, for the audit entry", async () => {
    tx.user.findFirst.mockResolvedValue(disposable({ _count: { memberships: 2 } }));
    const out = await run();
    expect(out.reason).toMatch(/organisation/i);
  });
});
