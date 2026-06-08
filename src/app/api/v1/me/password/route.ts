import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { hashPassword, verifyPassword, passwordPolicyError } from "@/lib/auth/password";

const schema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(1).max(200),
});

/** Set or change the signed-in user's password. Changing an existing password
 *  requires the current one; first-time set just needs an authenticated session
 *  (they're already signed in via Google/SSO). */
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
  if (user?.passwordHash) {
    if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
      return NextResponse.json(
        { error: "Your current password is incorrect." },
        { status: 403 },
      );
    }
  }

  await prisma.user.update({
    where: { id: me.id },
    data: { passwordHash: hashPassword(newPassword), passwordSetAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
