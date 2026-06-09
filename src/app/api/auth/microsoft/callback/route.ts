import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/client";
import {
  MS_STATE_COOKIE,
  exchangeMicrosoftCode,
  fetchMicrosoftProfile,
  microsoftRedirectUri,
} from "@/lib/auth/microsoft";
import { getProviderConfig } from "@/lib/auth/provider-config";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { OrgRole } from "@prisma/client";
import { autoJoinGeneral } from "@/lib/chat/seed-general";
import { googleLoginBlockedByGovSso } from "@/lib/auth/sso-enforcement";

function redirectToLogin(origin: string, error: string) {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(error)}`, origin),
  );
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const origin = getPublicOrigin(request);

  const cfg = await getProviderConfig("microsoft");
  if (!cfg || !cfg.enabled) {
    return redirectToLogin(origin, "ms_not_configured");
  }

  const rl = rateLimit(getRateLimitKey(request, "auth.callback"), {
    capacity: 10,
    refillPerSecond: 1,
  });
  if (!rl.allowed) return redirectToLogin(origin, "rate_limited");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(MS_STATE_COOKIE)?.value;

  if (!code || !state || !cookieState || state !== cookieState) {
    const res = redirectToLogin(origin, "invalid_state");
    res.cookies.delete(MS_STATE_COOKIE);
    return res;
  }

  let email: string;
  let displayName: string;
  try {
    const tokens = await exchangeMicrosoftCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      tenant: cfg.tenant,
      code,
      redirectUri: microsoftRedirectUri(request),
    });
    if (!tokens.access_token) {
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(MS_STATE_COOKIE);
      return res;
    }
    const profile = await fetchMicrosoftProfile(tokens.access_token);
    email = profile.email;
    displayName = profile.displayName;
  } catch {
    const res = redirectToLogin(origin, "auth_failed");
    res.cookies.delete(MS_STATE_COOKIE);
    return res;
  }

  // Allowlist parity with the Google path: ALLOWED_EMAILS env bootstrap on top
  // of the DB-managed allowed_emails table.
  const envAllowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const dbAllowed = envAllowed.includes(email)
    ? true
    : Boolean(await prisma.allowedEmail.findUnique({ where: { email } }));
  if (!dbAllowed) {
    const res = redirectToLogin(origin, "not_allowed");
    res.cookies.delete(MS_STATE_COOKIE);
    return res;
  }

  // Find or create by email. We don't store a provider id for Microsoft (no
  // schema column) — the email is the identity, shared with any existing
  // Google/SSO account for the same address.
  let user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, displayName, lastActiveAt: new Date() },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });
  }

  // SSO-enforcement parity: a member/invitee of a GOV org with an enabled +
  // enforced IdP must authenticate via that IdP, not Microsoft consumer/work
  // sign-in. INTERNAL_ADMINS are exempt (break-glass).
  if (await googleLoginBlockedByGovSso({ email, userId: user.id })) {
    const res = redirectToLogin(origin, "sso_enforced");
    res.cookies.delete(MS_STATE_COOKIE);
    return res;
  }

  // Consume pending invitations addressed to this email (skips the empty
  // /onboarding redirect for invited users).
  const pendingInvites = await prisma.invitation.findMany({
    where: { email, expiresAt: { gt: new Date() } },
  });
  for (const invite of pendingInvites) {
    const newMember = await prisma.orgMember
      .create({
        data: { orgId: invite.orgId, userId: user.id, role: invite.role },
      })
      .catch(() => undefined); // race: already a member is fine
    if (newMember) {
      try {
        await autoJoinGeneral(
          newMember.orgId,
          newMember.userId,
          newMember.role === OrgRole.OWNER || newMember.role === OrgRole.ADMIN,
        );
      } catch (err) {
        console.warn(
          "[chat] failed to auto-join invited OrgMember to #general",
          { orgId: newMember.orgId, userId: newMember.userId },
          err,
        );
      }
    }
    await prisma.invitation
      .delete({ where: { id: invite.id } })
      .catch(() => undefined);
  }

  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await prisma.session.create({
    data: { id: sessionId, userId: user.id, expiresAt },
  });

  const response = NextResponse.redirect(new URL("/", origin));
  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.delete(MS_STATE_COOKIE);
  return response;
}
