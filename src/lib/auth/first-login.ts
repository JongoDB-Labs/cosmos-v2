import { prisma } from "@/lib/db/client";
import { sealSecret, openSecret } from "@/lib/crypto/vault";

/**
 * Forced first-login onboarding (email/password invites).
 *
 * Between the password check and a real session, an invitee may still owe two
 * steps: rotate the admin-generated temporary password (mustChangePassword) and
 * enroll TOTP if the invite required MFA. We DON'T mint a session until those are
 * done — so no partly-onboarded session can slip past the org gate (which would
 * otherwise redirect-loop). The proof-of-password-check between requests is a
 * short-lived sealed cookie (same primitive as the MFA-pending cookie), not a
 * session; it carries only the user id + issue time, AES-256-GCM sealed.
 */
export const FIRST_LOGIN_COOKIE = "first_login";
/** Whole onboarding window (password change + TOTP enroll can take a minute). */
export const FIRST_LOGIN_TTL_MS = 15 * 60 * 1000;

export function sealFirstLogin(userId: string): string {
  return sealSecret(JSON.stringify({ userId, ts: Date.now() }));
}

export const FIRST_LOGIN_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: Math.floor(FIRST_LOGIN_TTL_MS / 1000),
  secure: process.env.NODE_ENV === "production",
};

export type FirstLoginUser = {
  id: string;
  email: string;
  mustChangePassword: boolean;
  mfaRequired: boolean;
  mfaEnabled: boolean;
  passwordHash: string | null;
  mfaSecret: string | null;
  mfaRecoveryCodes: string[];
};

/**
 * Open + validate the sealed first-login cookie and load the user it names, or
 * null when the cookie is missing, tampered, expired, or the user is gone.
 */
export async function loadFirstLoginUser(
  cookieValue: string | undefined,
): Promise<FirstLoginUser | null> {
  if (!cookieValue) return null;
  let payload: { userId?: string; ts?: number };
  try {
    payload = JSON.parse(openSecret(cookieValue));
  } catch {
    return null;
  }
  if (!payload?.userId || !payload.ts) return null;
  if (Date.now() - payload.ts > FIRST_LOGIN_TTL_MS) return null;

  return prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      mustChangePassword: true,
      mfaRequired: true,
      mfaEnabled: true,
      passwordHash: true,
      mfaSecret: true,
      mfaRecoveryCodes: true,
    },
  });
}

/**
 * The next onboarding step a user owes, given their flags. Pure so it can be
 * unit-tested and shared by the login route + the change endpoint.
 *  - "change_password": temp password must be rotated first.
 *  - "enroll_mfa": MFA required by the invite but not yet enrolled.
 *  - "mfa": already enrolled — verify a TOTP code (existing phase-2 flow).
 *  - null: nothing owed — mint a session.
 */
export function nextFirstLoginStep(user: {
  mustChangePassword: boolean;
  mfaRequired: boolean;
  mfaEnabled: boolean;
}): "change_password" | "enroll_mfa" | "mfa" | null {
  if (user.mustChangePassword) return "change_password";
  if (user.mfaRequired && !user.mfaEnabled) return "enroll_mfa";
  if (user.mfaEnabled) return "mfa";
  return null;
}
