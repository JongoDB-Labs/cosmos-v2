import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  finishPasswordLogin,
  MFA_PENDING_COOKIE,
} from "@/lib/auth/local-session";
import {
  sealFirstLogin,
  FIRST_LOGIN_COOKIE,
  FIRST_LOGIN_COOKIE_OPTIONS,
  nextFirstLoginStep,
} from "@/lib/auth/first-login";
import { sealSecret } from "@/lib/crypto/vault";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { getIpAddress } from "@/lib/api-helpers";
import { googleLoginBlockedByGovSso } from "@/lib/auth/sso-enforcement";

const MFA_PENDING_TTL = 300; // 5 minutes to complete the second factor

// A realistic-cost hash verified for unknown emails so response timing doesn't
// reveal whether an email has a password (user-enumeration resistance).
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

const schema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const ip = getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`pwlogin:${ip}`, { capacity: 10, refillPerSecond: 0.2 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait and try again." },
      { status: 429 },
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 400 });
  }
  const { email, password } = parsed.data;

  // Per-account brake (in addition to per-IP) so password spraying across many
  // accounts — or a spoofed X-Forwarded-For rotating the IP key — still throttles.
  const acctRl = rateLimit(`pwlogin:acct:${email.trim().toLowerCase()}`, {
    capacity: 5,
    refillPerSecond: 0.1,
  });
  if (!acctRl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts for this account. Please wait." },
      { status: 429 },
    );
  }

  const user = await prisma.user.findFirst({
    where: {
      email: { equals: email.trim(), mode: "insensitive" },
      passwordHash: { not: null },
      isBot: false,
    },
    select: {
      id: true,
      passwordHash: true,
      mfaEnabled: true,
      mustChangePassword: true,
      mfaRequired: true,
    },
  });

  let ok = false;
  if (user?.passwordHash) ok = verifyPassword(password, user.passwordHash);
  else verifyPassword(password, DUMMY_HASH); // burn time on the no-user path

  if (!user || !ok) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  // SSO-enforcement parity with the Google callback: a member/invitee of a GOV
  // org whose IdP is enabled+enforced MUST authenticate via the IdP (which
  // asserts the AAL/MFA floor), not via local password. Closes the symmetric
  // bypass the Google path already guards.
  if (await googleLoginBlockedByGovSso({ email, userId: user.id })) {
    return NextResponse.json(
      { error: "This organization requires single sign-on." },
      { status: 403 },
    );
  }

  // Forced first-login onboarding (email/password invites): rotate the temporary
  // password and/or enroll MFA BEFORE any session is minted. We hand back a
  // short-lived sealed first-login cookie and tell the client the next step; the
  // /api/auth/password/first-login/* endpoints drive it and mint the session only
  // once everything the invite required is satisfied.
  const step = nextFirstLoginStep(user);
  if (step === "change_password" || step === "enroll_mfa") {
    const res = NextResponse.json({ next: step, mfaRequired: user.mfaRequired });
    res.cookies.set(FIRST_LOGIN_COOKIE, sealFirstLogin(user.id), FIRST_LOGIN_COOKIE_OPTIONS);
    return res;
  }

  // MFA already enrolled → don't mint a session yet; hand back a short-lived
  // sealed pending token and require the TOTP/recovery step at
  // /api/auth/password/mfa (unchanged existing flow).
  if (step === "mfa") {
    const pending = sealSecret(JSON.stringify({ userId: user.id, ts: Date.now() }));
    const res = NextResponse.json({ mfaRequired: true });
    res.cookies.set(MFA_PENDING_COOKIE, pending, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: MFA_PENDING_TTL,
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  }

  // Nothing owed → mint the session (and accept any pending invitations).
  const res = NextResponse.json({ ok: true });
  await finishPasswordLogin(res, { userId: user.id, email, mfaSatisfied: false });
  return res;
}
