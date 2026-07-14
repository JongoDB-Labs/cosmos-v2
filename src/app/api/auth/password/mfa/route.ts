import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { verifyTotp, consumeRecoveryCode } from "@/lib/auth/totp";
import { openSecret } from "@/lib/crypto/vault";
import {
  finishPasswordLogin,
  MFA_PENDING_COOKIE,
  MFA_PENDING_TTL_MS,
} from "@/lib/auth/local-session";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { getIpAddress } from "@/lib/api-helpers";

const schema = z.object({ code: z.string().min(1).max(20) });

/** Phase 2 of password login: verify the TOTP (or a recovery code) and mint a
 *  high-assurance session. Reads the sealed pending token from phase 1. */
export async function POST(request: NextRequest) {
  const ip = getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`pwmfa:${ip}`, { capacity: 8, refillPerSecond: 0.2 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait." }, { status: 429 });
  }

  const expire = () => {
    const res = NextResponse.json(
      { error: "Your sign-in expired. Please start over." },
      { status: 401 },
    );
    res.cookies.delete(MFA_PENDING_COOKIE);
    return res;
  };

  const pendingCookie = request.cookies.get(MFA_PENDING_COOKIE)?.value;
  if (!pendingCookie) return expire();
  let pending: { userId?: string; ts?: number };
  try {
    pending = JSON.parse(openSecret(pendingCookie));
  } catch {
    return expire();
  }
  if (!pending?.userId || !pending.ts || Date.now() - pending.ts > MFA_PENDING_TTL_MS) {
    return expire();
  }

  // Per-account brake so TOTP brute-force can't be parallelized across IPs.
  const acctRl = rateLimit(`pwmfa:user:${pending.userId}`, {
    capacity: 6,
    refillPerSecond: 0.1,
  });
  if (!acctRl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait." }, { status: 429 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your 6-digit code." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: pending.userId },
    select: {
      id: true,
      email: true,
      mfaEnabled: true,
      mfaSecret: true,
      mfaRecoveryCodes: true,
    },
  });
  if (!user || !user.mfaEnabled || !user.mfaSecret) return expire();

  const code = parsed.data.code;
  let verified = false;
  try {
    verified = verifyTotp(openSecret(user.mfaSecret), code);
  } catch {
    verified = false;
  }
  if (!verified) {
    const r = consumeRecoveryCode(code, user.mfaRecoveryCodes);
    if (r.ok) {
      verified = true;
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaRecoveryCodes: r.remaining },
      });
    }
  }
  if (!verified) {
    return NextResponse.json({ error: "Invalid code. Try again." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  await finishPasswordLogin(res, {
    userId: user.id,
    email: user.email,
    mfaSatisfied: true,
  });
  res.cookies.delete(MFA_PENDING_COOKIE);
  return res;
}
