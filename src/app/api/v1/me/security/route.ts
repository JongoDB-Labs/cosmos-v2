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
      passwordHash: true,
      passwordSetAt: true,
      mfaEnabled: true,
      mfaRecoveryCodes: true,
    },
  });

  return NextResponse.json({
    hasPassword: Boolean(user?.passwordHash),
    passwordSetAt: user?.passwordSetAt ?? null,
    mfaEnabled: user?.mfaEnabled ?? false,
    recoveryCodesRemaining: user?.mfaRecoveryCodes.length ?? 0,
  });
}
