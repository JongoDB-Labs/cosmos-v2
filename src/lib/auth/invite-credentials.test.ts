// @vitest-environment node
//
// provisionEmailPasswordInvite — the credential side of an email/password invite.
// Locks the security-critical guarantees: a temp password is generated + HASHED
// (never stored raw), the force-rotate flag is set, the MFA floor is threaded,
// and an existing self-chosen password is NEVER clobbered by a re-invite.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { provisionEmailPasswordInvite } from "./invite-credentials";
import { verifyPassword } from "./password";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provisionEmailPasswordInvite", () => {
  it("creates a new local user with a hashed temp password + force-rotate flag", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: "new-user" });

    const res = await provisionEmailPasswordInvite({
      email: "New.Person@Example.com",
      mfaRequired: false,
    });

    expect(res.userId).toBe("new-user");
    expect(res.tempPassword).toBeTruthy();

    const data = prisma.user.create.mock.calls[0][0].data;
    // Stored hash must NOT be the plaintext, and must verify against it.
    expect(data.passwordHash).not.toContain(res.tempPassword);
    expect(verifyPassword(res.tempPassword as string, data.passwordHash)).toBe(true);
    expect(data.mustChangePassword).toBe(true);
    expect(data.mfaRequired).toBe(false);
    expect(data.email).toBe("new.person@example.com"); // normalized
    expect(data.passwordSetAt).toBeInstanceOf(Date);
  });

  it("threads the MFA-required floor onto a newly created user", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({ id: "u2" });

    await provisionEmailPasswordInvite({ email: "x@y.com", mfaRequired: true });

    expect(prisma.user.create.mock.calls[0][0].data.mfaRequired).toBe(true);
  });

  it("attaches a temp credential to an existing OAuth-only user (no password yet)", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "oauth-user", passwordHash: null });
    prisma.user.update.mockResolvedValue({ id: "oauth-user" });

    const res = await provisionEmailPasswordInvite({
      email: "oauth@example.com",
      mfaRequired: true,
    });

    expect(res.userId).toBe("oauth-user");
    expect(res.tempPassword).toBeTruthy();
    expect(prisma.user.create).not.toHaveBeenCalled();
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(verifyPassword(res.tempPassword as string, data.passwordHash)).toBe(true);
    expect(data.mustChangePassword).toBe(true);
    expect(data.mfaRequired).toBe(true);
  });

  it("NEVER clobbers an existing self-chosen password on re-invite", async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: "real-user",
      passwordHash: "scrypt$16384$8$1$deadbeef$cafe",
    });
    prisma.user.update.mockResolvedValue({ id: "real-user" });

    const res = await provisionEmailPasswordInvite({
      email: "real@example.com",
      mfaRequired: true,
    });

    expect(res.tempPassword).toBeNull(); // email tells them to use their own pw
    expect(prisma.user.create).not.toHaveBeenCalled();
    // Only the MFA floor may be raised — the password must be untouched.
    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data).toEqual({ mfaRequired: true });
    expect(data.passwordHash).toBeUndefined();
    expect(data.mustChangePassword).toBeUndefined();
  });

  it("leaves an existing password user fully untouched when MFA is not required", async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: "real-user",
      passwordHash: "scrypt$16384$8$1$dead$beef",
    });

    const res = await provisionEmailPasswordInvite({
      email: "real@example.com",
      mfaRequired: false,
    });

    expect(res).toEqual({ userId: "real-user", tempPassword: null });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
