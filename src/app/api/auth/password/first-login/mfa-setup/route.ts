import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { generateTotpSecret, totpUri } from "@/lib/auth/totp";
import { sealSecret } from "@/lib/crypto/vault";
import { loadFirstLoginUser, FIRST_LOGIN_COOKIE } from "@/lib/auth/first-login";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { getIpAddress } from "@/lib/api-helpers";

/**
 * Begin forced TOTP enrollment during first-login onboarding (invite required
 * MFA). Authorized ONLY by the sealed first-login cookie. Mints a pending secret
 * (sealed at rest; mfaEnabled stays false) and returns it + the otpauth URI so
 * the login page can render the QR. Finalized by /mfa-enroll.
 */
export async function POST(request: NextRequest) {
  const ip = getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`pwmfasetup:${ip}`, { capacity: 10, refillPerSecond: 0.2 });
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Please wait." }, { status: 429 });
  }

  const user = await loadFirstLoginUser(request.cookies.get(FIRST_LOGIN_COOKIE)?.value);
  if (!user) {
    const res = NextResponse.json(
      { error: "Your sign-in expired. Please start over." },
      { status: 401 },
    );
    res.cookies.delete(FIRST_LOGIN_COOKIE);
    return res;
  }

  // Ordering: the temp password must be rotated first.
  if (user.mustChangePassword) {
    return NextResponse.json({ error: "Set your new password first." }, { status: 400 });
  }
  if (!user.mfaRequired || user.mfaEnabled) {
    return NextResponse.json({ error: "No two-factor setup is required." }, { status: 400 });
  }

  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: sealSecret(secret) }, // pending; mfaEnabled stays false
  });

  return NextResponse.json({ secret, otpauthUri: totpUri(secret, user.email) });
}
