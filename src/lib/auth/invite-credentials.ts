import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { generateTempPassword } from "@/lib/auth/temp-password";
import { ConflictError } from "@/lib/rbac/check";

/** Valid values for Invitation.signInMethod / the invite API. */
export const SIGN_IN_METHODS = ["oauth", "email_password"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export type ProvisionResult = {
  userId: string;
  /** The plaintext temporary password to EMAIL exactly once. Only ever produced
   *  for a brand-new account (see the security note below). */
  tempPassword: string;
};

/** Thrown when an email/password invite targets an email that already resolves
 *  to a User. Surfaced to the inviter as an HTTP 409 (via handleApiError). */
export const EMAIL_PASSWORD_INVITE_EXISTING_USER =
  "That email already has an account; invite them via OAuth or have them sign in with their existing password.";

/**
 * Provision the local credential for an "email_password" invite.
 *
 * SECURITY (cross-tenant account takeover): an email/password invite may ONLY
 * provision a BRAND-NEW account. If the invited email already resolves to ANY
 * existing User — a member of this org or not — we must NEVER attach or modify
 * an admin-generated credential (passwordHash / mustChangePassword / mfaRequired)
 * on it. Sessions are user-global, so letting an org owner set the password of a
 * pre-existing (e.g. OAuth-only) account would hand them that user's access
 * everywhere. In that case we throw and the caller rejects the invite, telling
 * the inviter to use OAuth (or have the user sign in with their own password)
 * instead. Existing users join a new org through the normal membership / pending
 * invitation grant — never an admin-set password.
 *
 * New email → create a local user with a strong temporary password, forced to
 * rotate at first sign-in (mustChangePassword), carrying the invite's MFA floor.
 *
 * The returned plaintext password is the ONLY time it exists outside a scrypt
 * hash — the caller emails it and drops it. It is never logged, never persisted
 * raw, and never returned in an API response.
 *
 * `client` lets the caller run this inside a transaction alongside the
 * Invitation insert, so a failure on either side can't leave an orphan account.
 */
export async function provisionEmailPasswordInvite(params: {
  email: string;
  mfaRequired: boolean;
  client?: Prisma.TransactionClient;
}): Promise<ProvisionResult> {
  const db = params.client ?? prisma;
  const email = params.email.trim().toLowerCase();

  const existing = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });

  // Never touch a pre-existing account — reject the invite outright.
  if (existing) {
    throw new ConflictError(EMAIL_PASSWORD_INVITE_EXISTING_USER);
  }

  const tempPassword = generateTempPassword();
  const passwordHash = hashPassword(tempPassword);

  const created = await db.user.create({
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
