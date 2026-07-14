// @vitest-environment node
//
// provisionEmailPasswordInvite — the credential side of an email/password invite.
// Locks the security-critical guarantees:
//   - a BRAND-NEW account gets a generated + HASHED temp password (never stored
//     raw), the force-rotate flag, and the invite's MFA floor, and the plaintext
//     is returned exactly once (for the caller to email);
//   - it REFUSES to touch a PRE-EXISTING account (member of this org or not):
//     no passwordHash / mustChangePassword / mfaRequired is ever written onto an
//     existing User via an invite — that would be a cross-tenant takeover vector.
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

import {
  provisionEmailPasswordInvite,
  EMAIL_PASSWORD_INVITE_EXISTING_USER,
} from "./invite-credentials";
import { ConflictError } from "@/lib/rbac/check";
import { verifyPassword } from "./password";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provisionEmailPasswordInvite — brand-new account", () => {
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
    expect(verifyPassword(res.tempPassword, data.passwordHash)).toBe(true);
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
});

describe("provisionEmailPasswordInvite — refuses any pre-existing account", () => {
  it("rejects an existing OAuth-only user (no password) without writing a credential", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "oauth-user" }); // passwordHash null

    await expect(
      provisionEmailPasswordInvite({ email: "oauth@example.com", mfaRequired: true }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Cross-tenant takeover guard: NOTHING is written onto the existing user.
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects an existing user who already has a password (no reset / lockout)", async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: "real-user",
      passwordHash: "scrypt$16384$8$1$deadbeef$cafe",
    });

    await expect(
      provisionEmailPasswordInvite({ email: "real@example.com", mfaRequired: true }),
    ).rejects.toThrow(EMAIL_PASSWORD_INVITE_EXISTING_USER);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
