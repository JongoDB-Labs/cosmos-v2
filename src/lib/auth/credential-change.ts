import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";

/**
 * What happens after a user's own credentials change: a password is set,
 * changed or reset, or MFA is turned off.
 *
 * Their other sign-ins end. If someone else holds one of the user's sessions,
 * changing the password is what the user does about it, so it has to work. The
 * session making the change is kept (the user is still at the keyboard); a
 * reset from an emailed link has no session, so it ends all of them.
 *
 * Deleting the `Session` row is what ends a sign-in. The `SessionRecord`
 * mirrors that the org Sessions view lists are marked REVOKED to match,
 * best-effort, as `revokeOrgSessions` does.
 */
export async function endOtherSessions(userId: string, keepSessionId?: string | null): Promise<number> {
  const keep = keepSessionId ? { not: keepSessionId } : undefined;
  const ended = await prisma.session.deleteMany({
    where: { userId, ...(keep ? { id: keep } : {}) },
  });
  await prisma.sessionRecord
    .updateMany({
      where: { userId, status: "ACTIVE", ...(keep ? { sessionToken: keep } : {}) },
      data: { status: "REVOKED", revokedAt: new Date() },
    })
    .catch(() => undefined);
  return ended.count;
}

/**
 * Record a change to the user's own credentials in every org they belong to:
 * the credential signs them into all of them, so each org's audit log should
 * show it. Best-effort, because the change has already been made; a failed
 * audit write must not report it as failed.
 */
export async function auditCredentialChange(
  userId: string,
  action: "auth.password.set" | "auth.password.changed" | "auth.mfa.disabled",
  ipAddress?: string,
): Promise<void> {
  try {
    const memberships = await prisma.orgMember.findMany({ where: { userId }, select: { orgId: true } });
    for (const { orgId } of memberships) {
      await logAudit({ orgId, userId, action, entity: "user", entityId: userId, ipAddress });
    }
  } catch (e) {
    // eslint-disable-next-line no-restricted-syntax -- operator-facing, best-effort
    console.error(`[credential-change] ${action} audit failed for ${userId}:`, e);
  }
}

/**
 * How recent a sign-in must be to set a FIRST password on an account that
 * signs in only through Google or SSO. Without it, anyone holding the session
 * cookie could add a password and keep a way in that the identity provider
 * can't revoke. Signing in again proves the person is at the keyboard now.
 */
export const FIRST_PASSWORD_SIGN_IN_WINDOW_MS = 10 * 60_000;
