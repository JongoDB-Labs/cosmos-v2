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
import { POST as requestReset } from "./request/route";
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
