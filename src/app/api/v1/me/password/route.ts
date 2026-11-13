import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { hashPassword, verifyPassword, passwordPolicyError } from "@/lib/auth/password";
import { getIpAddress } from "@/lib/api-helpers";
import {
  auditCredentialChange,
  endOtherSessions,
  FIRST_PASSWORD_SIGN_IN_WINDOW_MS,
} from "@/lib/auth/credential-change";
import { canSetFirstPassword } from "@/lib/internal/access";

const schema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(1).max(200),
});

/** Set or change the signed-in user's password. Changing an existing password
 *  requires the current one. Setting a FIRST one needs a Google or Microsoft
 *  session that vouches for the account's address (`canSetFirstPassword`): a
 *  password is a credential an IdP can't revoke, so an SSO session, or an
 *  account an IdP created, can't add one. That session must also be recent, not
 *  just valid: otherwise whoever holds the cookie could add one. Either way the
 *  user's other sessions end, and the change is audited. */
export async function POST(request: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("Unauthorized", { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { currentPassword, newPassword } = parsed.data;

  const policy = passwordPolicyError(newPassword);
  if (policy) return NextResponse.json({ error: policy }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: me.id },
    select: { passwordHash: true },
  });
  const first = !user?.passwordHash;
  if (user?.passwordHash) {
    if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
      return NextResponse.json(
        { error: "Your current password is incorrect." },
        { status: 403 },
      );
    }
  } else {
    const refusal = me.ssoProvisioned
      ? "This account signs in through your organization's single sign-on, so it can't have a password here."
      : "Sign in again with Google or Microsoft within the last 10 minutes to set a password.";
    if (!canSetFirstPassword(me)) {
      return NextResponse.json({ error: refusal }, { status: 403 });
    }
    const session = await prisma.session.findUnique({
      where: { id: me.sessionId },
      select: { createdAt: true },
    });
    const age = session ? Date.now() - session.createdAt.getTime() : Infinity;
    if (age > FIRST_PASSWORD_SIGN_IN_WINDOW_MS) {
      return NextResponse.json({ error: refusal }, { status: 403 });
    }
  }

  await prisma.user.update({
    where: { id: me.id },
    // A first password set here came from a session that vouches for the
    // address; a changed one keeps whatever standing the old one had.
    data: user?.passwordHash
      ? { passwordHash: hashPassword(newPassword), passwordSetAt: new Date() }
      : { passwordHash: hashPassword(newPassword), passwordSetAt: new Date(), passwordUntrusted: false },
  });
  await endOtherSessions(me.id, me.sessionId);
  await auditCredentialChange(me.id, first ? "auth.password.set" : "auth.password.changed", getIpAddress(request));
  return NextResponse.json({ ok: true });
}
