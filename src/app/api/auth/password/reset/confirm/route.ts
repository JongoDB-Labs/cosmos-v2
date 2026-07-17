import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getIpAddress } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { hashPassword, passwordPolicyError } from "@/lib/auth/password";
import {
  parsePasswordResetToken,
  resetFingerprint,
  fingerprintMatches,
} from "@/lib/auth/password-reset";

const schema = z.object({
  token: z.string().min(1).max(4096),
  newPassword: z.string().min(1).max(200),
});

const INVALID = "This reset link is invalid or has expired. Request a new one.";

/**
 * Complete a self-service / admin-triggered password reset. Verifies the signed
 * token (authenticity + expiry), then re-derives the credential fingerprint from
 * the user's CURRENT state and compares — a mismatch means the token was already
 * used (the password changed) or the credential otherwise moved on, enforcing
 * single-use. On success sets a policy-compliant new password and clears
 * mustChangePassword. The user then signs in normally with the new password.
 */
export async function POST(request: NextRequest) {
  const ip = getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`pwresetconfirm:${ip}`, { capacity: 10, refillPerSecond: 0.1 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait." }, { status: 429 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }
  const { token, newPassword } = parsed.data;

  const decoded = parsePasswordResetToken(token);
  if (!decoded) return NextResponse.json({ error: INVALID }, { status: 400 });

  const user = await prisma.user.findFirst({
    where: {
      id: decoded.uid,
      passwordHash: { not: null },
      isBot: false,
      deactivatedAt: null,
    },
    select: { id: true, passwordHash: true, passwordSetAt: true },
  });
  if (!user) return NextResponse.json({ error: INVALID }, { status: 400 });

  // Single-use: the token is bound to the credential state it was minted under.
  if (!fingerprintMatches(decoded.fp, resetFingerprint(user))) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  const policy = passwordPolicyError(newPassword);
  if (policy) return NextResponse.json({ error: policy }, { status: 400 });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(newPassword),
      passwordSetAt: new Date(),
      // A completed reset satisfies any pending forced rotation.
      mustChangePassword: false,
    },
  });

  return NextResponse.json({ ok: true });
}
