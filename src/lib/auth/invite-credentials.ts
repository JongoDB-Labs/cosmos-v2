import { prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { generateTempPassword } from "@/lib/auth/temp-password";

/** Valid values for Invitation.signInMethod / the invite API. */
export const SIGN_IN_METHODS = ["oauth", "email_password"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export type ProvisionResult = {
  userId: string;
  /** The plaintext temporary password to EMAIL exactly once, or null when the
   *  target already has their own password (we never clobber an existing one). */
  tempPassword: string | null;
};

/**
 * Provision the local credential for an "email_password" invite.
 *
 * - New email → create a local user with a strong temporary password, forced to
 *   rotate at first sign-in (mustChangePassword), carrying the invite's MFA floor.
 * - Existing OAuth-only user (no passwordHash) → attach the temporary credential
 *   so they can now sign in with email/password too (still force-rotated).
 * - Existing user who ALREADY has a password → never reset it (an admin re-invite
 *   must not become a password-reset / lockout vector). We only tighten the MFA
 *   floor if the invite asked for it, and return tempPassword: null so the email
 *   tells them to use their existing password.
 *
 * The returned plaintext password is the ONLY time it exists outside a scrypt
 * hash — the caller emails it and drops it. It is never logged or persisted raw.
 */
export async function provisionEmailPasswordInvite(params: {
  email: string;
  mfaRequired: boolean;
}): Promise<ProvisionResult> {
  const email = params.email.trim().toLowerCase();

  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, passwordHash: true },
  });

  // Already has a self-chosen password → do not touch it. Only raise the MFA
  // floor if requested; membership is still granted on their next password login.
  if (existing?.passwordHash) {
    if (params.mfaRequired) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { mfaRequired: true },
      });
    }
    return { userId: existing.id, tempPassword: null };
  }

  const tempPassword = generateTempPassword();
  const passwordHash = hashPassword(tempPassword);

  if (existing) {
    // OAuth-only user gaining a local credential.
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        passwordSetAt: new Date(),
        mustChangePassword: true,
        mfaRequired: params.mfaRequired,
      },
    });
    return { userId: existing.id, tempPassword };
  }

  const created = await prisma.user.create({
    data: {
      email,
      // Placeholder display name (the local-part) — the invitee can change it in
      // their profile. Mirrors how JIT-created OAuth users start from the IdP name.
      displayName: email.split("@")[0] || email,
      passwordHash,
      passwordSetAt: new Date(),
      mustChangePassword: true,
      mfaRequired: params.mfaRequired,
    },
    select: { id: true },
  });
  return { userId: created.id, tempPassword };
}
