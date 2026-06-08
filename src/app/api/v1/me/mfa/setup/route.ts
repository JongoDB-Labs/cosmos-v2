import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { generateTotpSecret, totpUri } from "@/lib/auth/totp";
import { sealSecret } from "@/lib/crypto/vault";

/** Begin TOTP enrollment: mint a secret (NOT yet enabled), seal it at rest, and
 *  return it + the otpauth URI so the client can render the QR. Enrollment is
 *  finalized by POST /api/v1/me/mfa/enable with a valid code. */
export async function POST() {
  const me = await getCurrentUser();
  if (!me) return new Response("Unauthorized", { status: 401 });

  const existing = await prisma.user.findUnique({
    where: { id: me.id },
    select: { mfaEnabled: true },
  });
  if (existing?.mfaEnabled) {
    return NextResponse.json(
      { error: "Two-factor auth is already enabled. Disable it first to re-enroll." },
      { status: 409 },
    );
  }

  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: me.id },
    data: { mfaSecret: sealSecret(secret) }, // pending; mfaEnabled stays false
  });

  return NextResponse.json({ secret, otpauthUri: totpUri(secret, me.email) });
}
