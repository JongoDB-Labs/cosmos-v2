import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  hashPassword,
  verifyPassword,
  passwordPolicyError,
} from "@/lib/auth/password";
import {
  finishPasswordLogin,
  MFA_PENDING_COOKIE,
} from "@/lib/auth/local-session";
import {
  loadFirstLoginUser,
  FIRST_LOGIN_COOKIE,
  nextFirstLoginStep,
} from "@/lib/auth/first-login";
import { sealSecret } from "@/lib/crypto/vault";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { getIpAddress } from "@/lib/api-helpers";

const MFA_PENDING_TTL = 300;

const schema = z.object({ newPassword: z.string().min(1).max(200) });

/**
 * Forced first-login password rotation. Authorized ONLY by the sealed
 * first-login cookie (proof the temp password was just verified) — there is no
 * session yet. Sets the new password, clears mustChangePassword, then routes to
 * the next required step (MFA enroll / TOTP) or mints the session.
 */
export async function POST(request: NextRequest) {
  const ip = getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`pwchange:${ip}`, { capacity: 10, refillPerSecond: 0.2 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait." }, { status: 429 });
  }

  const expire = () => {
    const res = NextResponse.json(
      { error: "Your sign-in expired. Please start over." },
      { status: 401 },
    );
    res.cookies.delete(FIRST_LOGIN_COOKIE);
    return res;
  };

  const user = await loadFirstLoginUser(request.cookies.get(FIRST_LOGIN_COOKIE)?.value);
  if (!user) return expire();
  // Only valid while a rotation is actually owed (defense against replay).
  if (!user.mustChangePassword) return expire();

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a new password." }, { status: 400 });
  }
  const { newPassword } = parsed.data;

  const policy = passwordPolicyError(newPassword);
  if (policy) return NextResponse.json({ error: policy }, { status: 400 });

  // The new password must differ from the temporary one they were emailed.
  if (user.passwordHash && verifyPassword(newPassword, user.passwordHash)) {
    return NextResponse.json(
      { error: "Choose a password different from the temporary one." },
      { status: 400 },
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(newPassword),
      passwordSetAt: new Date(),
      mustChangePassword: false,
    },
  });

  // Re-evaluate with mustChangePassword now cleared.
  const next = nextFirstLoginStep({
    mustChangePassword: false,
    mfaRequired: user.mfaRequired,
    mfaEnabled: user.mfaEnabled,
  });

  if (next === "enroll_mfa") {
    // Keep the first-login cookie; the client continues to /mfa-setup.
    return NextResponse.json({ next: "enroll_mfa" });
  }

  if (next === "mfa") {
    // Already-enrolled edge case: hand off to the existing phase-2 TOTP flow.
    const pending = sealSecret(JSON.stringify({ userId: user.id, ts: Date.now() }));
    const res = NextResponse.json({ next: "mfa", mfaRequired: true });
    res.cookies.set(MFA_PENDING_COOKIE, pending, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: MFA_PENDING_TTL,
      secure: process.env.NODE_ENV === "production",
    });
    res.cookies.delete(FIRST_LOGIN_COOKIE);
    return res;
  }

  // Nothing else owed → mint the session (and accept pending invitations).
  const res = NextResponse.json({ ok: true });
  await finishPasswordLogin(res, {
    userId: user.id,
    email: user.email,
    mfaSatisfied: false,
  });
  res.cookies.delete(FIRST_LOGIN_COOKIE);
  return res;
}
