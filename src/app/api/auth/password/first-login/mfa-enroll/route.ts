import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/auth/totp";
import { openSecret } from "@/lib/crypto/vault";
import {
  finishPasswordLogin,
} from "@/lib/auth/local-session";
import { loadFirstLoginUser, FIRST_LOGIN_COOKIE } from "@/lib/auth/first-login";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { getIpAddress } from "@/lib/api-helpers";

const schema = z.object({ code: z.string().min(1).max(20) });

/**
 * Finalize forced TOTP enrollment: verify a code against the pending secret,
 * enable MFA, and mint a high-assurance (mfaSatisfied) session — completing the
 * invite's onboarding. Returns one-time recovery codes (stored hashed).
 * Authorized ONLY by the sealed first-login cookie.
 */
export async function POST(request: NextRequest) {
  const ip = getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`pwmfaenroll:${ip}`, { capacity: 8, refillPerSecond: 0.2 });
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

  // Per-account brake so TOTP brute-force can't be parallelized across IPs.
  const acctRl = rateLimit(`pwmfaenroll:user:${user.id}`, {
    capacity: 6,
    refillPerSecond: 0.1,
  });
  if (!acctRl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait." }, { status: 429 });
  }

  if (user.mustChangePassword) {
    return NextResponse.json({ error: "Set your new password first." }, { status: 400 });
  }
  if (!user.mfaRequired || user.mfaEnabled) {
    return NextResponse.json({ error: "No two-factor setup is required." }, { status: 400 });
  }
  if (!user.mfaSecret) {
    return NextResponse.json({ error: "Start setup first." }, { status: 400 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your 6-digit code." }, { status: 400 });
  }

  let ok = false;
  try {
    ok = verifyTotp(openSecret(user.mfaSecret), parsed.data.code);
  } catch {
    ok = false;
  }
  if (!ok) {
    return NextResponse.json({ error: "That code didn't match. Try again." }, { status: 401 });
  }

  const recoveryCodes = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaEnabled: true,
      mfaEnrolledAt: new Date(),
      mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
    },
  });

  // MFA just proven → mint an mfaSatisfied session and accept pending invitations.
  const res = NextResponse.json({ ok: true, recoveryCodes });
  await finishPasswordLogin(res, {
    userId: user.id,
    email: user.email,
    mfaSatisfied: true,
  });
  res.cookies.delete(FIRST_LOGIN_COOKIE);
  return res;
}
