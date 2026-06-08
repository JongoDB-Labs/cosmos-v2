import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";

/** Per-user auth posture for the Account Security panel. Booleans + a count
 *  only — never the hash, secret, or recovery codes. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return new Response("Unauthorized", { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: {
      email: true,
      passwordHash: true,
      passwordSetAt: true,
      mfaEnabled: true,
      mfaRecoveryCodes: true,
    },
  });

  return NextResponse.json({
    // The login email is the account's existing email (set by Google/SSO at
    // first sign-in) — there's no separate "username" to choose. Surface it so
    // users know exactly what to type at the email/password sign-in screen.
    email: user?.email ?? null,
    hasPassword: Boolean(user?.passwordHash),
    passwordSetAt: user?.passwordSetAt ?? null,
    mfaEnabled: user?.mfaEnabled ?? false,
    recoveryCodesRemaining: user?.mfaRecoveryCodes.length ?? 0,
  });
}
