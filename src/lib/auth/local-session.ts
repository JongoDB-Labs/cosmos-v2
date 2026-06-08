import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./client";

/**
 * Mint a session for a password (local) login, byte-identical to the
 * google/sso tail plus the assurance columns. `mfaSatisfied` reflects whether
 * a TOTP/recovery step completed this login — the existing assurance gate uses
 * it to enforce an org's `mfaRequired` floor.
 */
export async function createLocalSession(
  userId: string,
  opts: { mfaSatisfied: boolean },
): Promise<{ sessionId: string }> {
  const sessionId = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      expiresAt,
      authMethod: "password",
      amr: opts.mfaSatisfied ? ["pwd", "otp"] : ["pwd"],
      mfaSatisfied: opts.mfaSatisfied,
    },
  });
  return { sessionId };
}

/** Short-lived sealed cookie between password (phase 1) and TOTP (phase 2). */
export const MFA_PENDING_COOKIE = "mfa_pending";
export const MFA_PENDING_TTL_MS = 5 * 60 * 1000;

/** Cookie options shared by the login + MFA routes (matches google/callback). */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
  secure: process.env.NODE_ENV === "production",
};

export { SESSION_COOKIE };
