import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { verifyTotp, generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/totp";
import { openSecret } from "@/lib/crypto/vault";
import { SESSION_COOKIE } from "@/lib/auth/client";

const schema = z.object({ code: z.string().min(1).max(20) });

/** Finalize TOTP enrollment: verify a code against the pending secret, enable
 *  MFA, return one-time recovery codes (stored hashed), and upgrade the current
 *  session to mfaSatisfied so the user isn't locked out of an mfaRequired org. */
export async function POST(request: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("Unauthorized", { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your 6-digit code." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { mfaEnabled: true, mfaSecret: true },
  });
  if (user?.mfaEnabled) {
    return NextResponse.json({ error: "Two-factor auth is already enabled." }, { status: 409 });
  }
  if (!user?.mfaSecret) {
    return NextResponse.json({ error: "Start setup first." }, { status: 400 });
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
    where: { id: me.id },
    data: {
      mfaEnabled: true,
      mfaEnrolledAt: new Date(),
      mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
    },
  });

  // The user just proved possession of the second factor — upgrade THIS session
  // so an org's mfaRequired floor is satisfied immediately.
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (sid) {
    await prisma.session
      .update({ where: { id: sid }, data: { mfaSatisfied: true } })
      .catch(() => undefined);
  }

  // Shown ONCE — never retrievable again.
  return NextResponse.json({ recoveryCodes });
}
