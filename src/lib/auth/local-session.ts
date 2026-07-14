import { randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./client";
import { consumePendingInvitations } from "./consume-invitations";
import { setRememberedOrgCookie } from "./remembered-org";

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

/**
 * Complete a password (local) login on `res`: mint the session cookie, then —
 * best-effort — accept any pending invitations addressed to this email (the
 * membership grant the OAuth callbacks already do, now available to email/
 * password invitees) and remember the org for next login's branding.
 *
 * Invitation consumption + the remembered-org lookup are wrapped so a DB blip
 * there can never fail a login whose session is already minted.
 */
export async function finishPasswordLogin(
  res: NextResponse,
  opts: { userId: string; email: string; mfaSatisfied: boolean },
): Promise<NextResponse> {
  const { sessionId } = await createLocalSession(opts.userId, {
    mfaSatisfied: opts.mfaSatisfied,
  });
  res.cookies.set(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTIONS);

  // Grant membership from any pending invitations (invites are stored lowercased;
  // normalize the entered email so a case difference still matches).
  try {
    await consumePendingInvitations(opts.userId, opts.email.trim().toLowerCase());
  } catch {
    /* best-effort: an un-consumed invite just lands them on the org picker */
  }

  // Remember the org only when unambiguous (exactly one membership). Runs AFTER
  // consumption so a just-joined org counts.
  try {
    const memberships = await prisma.orgMember.findMany({
      where: { userId: opts.userId },
      select: { org: { select: { slug: true } } },
      take: 2,
    });
    if (memberships.length === 1) {
      setRememberedOrgCookie(res, memberships[0].org.slug);
    }
  } catch {
    /* remembered-org cookie is best-effort */
  }
  return res;
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
