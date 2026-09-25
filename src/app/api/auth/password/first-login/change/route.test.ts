// @vitest-environment node
//
// Locks the mfa_pending COOKIE LIFETIME to the single authoritative TTL in
// lib/auth/local-session. The server-side expiry check in password/mfa/route.ts
// compares against MFA_PENDING_TTL_MS; this route sets the cookie's maxAge. When
// the maxAge came from a local `MFA_PENDING_TTL = 300` literal the two agreed only
// by coincidence and could silently drift, so the mock below deliberately uses a
// NON-300-second TTL: the assertion passes only if maxAge is DERIVED from
// MFA_PENDING_TTL_MS rather than hardcoded.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { MOCK_TTL_MS, prisma, loadFirstLoginUser, nextFirstLoginStep, finishPasswordLogin } =
  vi.hoisted(() => ({
    MOCK_TTL_MS: 9 * 60 * 1000, // deliberately != 5 minutes
    prisma: { user: { update: vi.fn() } },
    loadFirstLoginUser: vi.fn(),
    nextFirstLoginStep: vi.fn(),
    finishPasswordLogin: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/rate-limit/bucket", () => ({ rateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/crypto/vault", () => ({ sealSecret: (s: string) => `sealed:${s}` }));
vi.mock("@/lib/auth/first-login", () => ({
  loadFirstLoginUser,
  nextFirstLoginStep,
  FIRST_LOGIN_COOKIE: "first_login",
}));
vi.mock("@/lib/auth/local-session", () => ({
  finishPasswordLogin,
  MFA_PENDING_COOKIE: "mfa_pending",
  MFA_PENDING_TTL_MS: MOCK_TTL_MS,
}));

import { POST } from "./route";

function post(newPassword: string) {
  return new NextRequest("http://localhost/api/auth/password/first-login/change", {
    method: "POST",
    body: JSON.stringify({ newPassword }),
    headers: { cookie: "first_login=sealed" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadFirstLoginUser.mockResolvedValue({
    id: "user-1",
    email: "invitee@example.com",
    passwordHash: null,
    mustChangePassword: true,
    mfaRequired: true,
    mfaEnabled: true,
  });
  nextFirstLoginStep.mockReturnValue("mfa");
  prisma.user.update.mockResolvedValue({});
});

describe("POST first-login/change — mfa_pending cookie lifetime", () => {
  it("derives maxAge from MFA_PENDING_TTL_MS, not a local literal", async () => {
    const res = await POST(post("brand-new-passphrase-9x"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "mfa", mfaRequired: true });
    expect(res.cookies.get("mfa_pending")?.maxAge).toBe(MOCK_TTL_MS / 1000);
  });
});
