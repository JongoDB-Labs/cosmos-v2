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
import { logAudit } from "@/lib/audit";
import { endOtherSessions } from "@/lib/auth/credential-change";

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
 * mustChangePassword, and ends every session the account had: a reset is what
 * someone does when another person may have their password. The user then
 * signs in normally with the new password.
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
    select: {
      id: true,
      email: true,
      passwordHash: true,
      passwordSetAt: true,
      memberships: { select: { org: { select: { id: true, slug: true } } } },
    },
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
      // The reset link went to the account's address, so the new password
      // vouches for it (see lib/internal/access).
      passwordUntrusted: false,
    },
  });
  await endOtherSessions(user.id);

  // A credential actually changed, so this is the half of the flow that most
  // needs a durable trail. Paired with auth.password_reset.requested, the two
  // answer "was a reset asked for, and did anyone complete it" — which no
  // record could answer before. Best-effort: the password IS already changed,
  // so a failed audit write must not report the reset as failed.
  // The org the account BELONGS to, read straight off the membership. Not
  // resolveSenderOrg: that deliberately falls back to whoever invited the
  // address, which is the right org to send mail AS and the wrong one to hand
  // a tenant-readable record of someone else's credential change. It also
  // costs a query here, and there is no mail to send on this path.
  const auditOrgId = user.memberships[0]?.org.id ?? null;
  if (auditOrgId) {
    try {
      await logAudit({
        orgId: auditOrgId,
        userId: user.id,
        action: "auth.password_reset.completed",
        entity: "user",
        entityId: user.id,
        metadata: { email: user.email.toLowerCase() },
        ipAddress: ip,
      });
    } catch (e) {
      // eslint-disable-next-line no-restricted-syntax -- operator-facing, best-effort
      console.error(`[password-reset] completion audit failed for ${user.id}:`, e);
    }
  }

  return NextResponse.json({ ok: true });
}
