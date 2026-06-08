import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { verifyTotp, consumeRecoveryCode } from "@/lib/auth/totp";
import { openSecret } from "@/lib/crypto/vault";

const schema = z.object({ code: z.string().min(1).max(20) });

/** Turn off TOTP. Requires a POSSESSION factor — a current TOTP code or a
 *  recovery code. Deliberately NOT the password alone: a session-hijack /
 *  stolen-cookie attacker who also knows the password (credential stuffing)
 *  must not be able to strip the second factor without the device. */
export async function POST(request: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("Unauthorized", { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { code } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { mfaEnabled: true, mfaSecret: true, mfaRecoveryCodes: true },
  });
  if (!user?.mfaEnabled) return NextResponse.json({ ok: true }); // already off

  let ok = false;
  if (user.mfaSecret) {
    try {
      ok = verifyTotp(openSecret(user.mfaSecret), code);
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = consumeRecoveryCode(code, user.mfaRecoveryCodes).ok;
  if (!ok) {
    return NextResponse.json(
      { error: "Enter a current authenticator code or a recovery code." },
      { status: 403 },
    );
  }

  await prisma.user.update({
    where: { id: me.id },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaRecoveryCodes: [],
      mfaEnrolledAt: null,
    },
  });
  return NextResponse.json({ ok: true });
}
