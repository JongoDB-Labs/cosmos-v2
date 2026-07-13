// @vitest-environment node
//
// Forced first-login step machine + sealed-cookie round trip. The step order is
// the security contract: rotate the temp password BEFORE MFA enrollment, and
// never report "done" while either is outstanding.
import { describe, it, expect, vi, beforeEach } from "vitest";

// A throwaway 32-byte base64 vault key so sealSecret/openSecret work in-process.
process.env.SSO_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

const { prisma } = vi.hoisted(() => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import {
  nextFirstLoginStep,
  sealFirstLogin,
  loadFirstLoginUser,
  FIRST_LOGIN_TTL_MS,
} from "./first-login";

beforeEach(() => vi.clearAllMocks());

describe("nextFirstLoginStep", () => {
  it("demands the password rotation first, before anything else", () => {
    expect(
      nextFirstLoginStep({ mustChangePassword: true, mfaRequired: true, mfaEnabled: false }),
    ).toBe("change_password");
  });

  it("demands MFA enrollment when required and not yet enrolled", () => {
    expect(
      nextFirstLoginStep({ mustChangePassword: false, mfaRequired: true, mfaEnabled: false }),
    ).toBe("enroll_mfa");
  });

  it("asks for a TOTP code when MFA is already enrolled", () => {
    expect(
      nextFirstLoginStep({ mustChangePassword: false, mfaRequired: false, mfaEnabled: true }),
    ).toBe("mfa");
  });

  it("returns null (mint a session) when nothing is owed", () => {
    expect(
      nextFirstLoginStep({ mustChangePassword: false, mfaRequired: false, mfaEnabled: false }),
    ).toBeNull();
  });
});

describe("loadFirstLoginUser", () => {
  it("opens a freshly sealed cookie and loads the named user", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.com" });
    const cookie = sealFirstLogin("u1");

    const user = await loadFirstLoginUser(cookie);

    expect(user).toEqual({ id: "u1", email: "a@b.com" });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" } }),
    );
  });

  it("rejects a missing / tampered cookie without hitting the DB", async () => {
    expect(await loadFirstLoginUser(undefined)).toBeNull();
    expect(await loadFirstLoginUser("not-a-sealed-value")).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an expired cookie", async () => {
    const realNow = Date.now;
    const cookie = sealFirstLogin("u1");
    // Jump past the TTL.
    vi.spyOn(Date, "now").mockReturnValue(realNow() + FIRST_LOGIN_TTL_MS + 1000);
    try {
      expect(await loadFirstLoginUser(cookie)).toBeNull();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    } finally {
      (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });
});
