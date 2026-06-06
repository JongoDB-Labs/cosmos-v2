import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  googleClient,
} from "@/lib/auth/client";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";
import { OrgRole } from "@prisma/client";
import { autoJoinGeneral } from "@/lib/chat/seed-general";

function redirectToLogin(origin: string, error: string) {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(error)}`, origin),
  );
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  // Use the public origin from forwarded headers — `url.origin` would be the
  // internal bind hostname (localhost:3000), breaking redirects behind nginx.
  const origin = getPublicOrigin(request);

  // Brake brute-force callback hits per IP — 10/minute, 1/sec sustained.
  const rl = rateLimit(getRateLimitKey(request, "auth.callback"), {
    capacity: 10,
    refillPerSecond: 1,
  });
  if (!rl.allowed) {
    return redirectToLogin(origin, "rate_limited");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code || !state || !cookieState || state !== cookieState) {
    const res = redirectToLogin(origin, "invalid_state");
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }

  let email: string | null = null;
  let googleId: string | null = null;
  let displayName = "";
  let avatarUrl: string | null = null;
  let refreshToken: string | null = null;

  try {
    const { tokens } = await googleClient.getToken(code);
    if (!tokens.id_token) {
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(OAUTH_STATE_COOKIE);
      return res;
    }
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) {
      const res = redirectToLogin(origin, "auth_failed");
      res.cookies.delete(OAUTH_STATE_COOKIE);
      return res;
    }
    email = payload.email.toLowerCase();
    googleId = payload.sub;
    displayName = payload.name ?? email.split("@")[0];
    avatarUrl = payload.picture ?? null;
    // Google only returns a refresh_token on first consent or when
    // prompt=consent forces re-consent. Capture it when present so we can
    // call Calendar/Drive/Gmail on behalf of the user later.
    refreshToken = tokens.refresh_token ?? null;
  } catch {
    const res = redirectToLogin(origin, "auth_failed");
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }

  // Allowlist check. ALLOWED_EMAILS env var (comma-separated) acts as a
  // permanent bootstrap allowlist on top of the DB-managed allowed_emails table.
  const envAllowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isEnvAllowed = envAllowed.includes(email);
  const dbAllowed = isEnvAllowed
    ? true
    : Boolean(await prisma.allowedEmail.findUnique({ where: { email } }));
  if (!dbAllowed) {
    const res = redirectToLogin(origin, "not_allowed");
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  }

  // Find or create the user. Prefer match by googleId, then by email.
  let user = await prisma.user.findUnique({ where: { googleId } });
  if (!user) {
    const existingByEmail = await prisma.user.findFirst({ where: { email } });
    if (existingByEmail) {
      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          googleId,
          displayName: existingByEmail.displayName || displayName,
          avatarUrl: avatarUrl ?? existingByEmail.avatarUrl,
          lastActiveAt: new Date(),
          ...(refreshToken ? { googleRefreshToken: refreshToken } : {}),
        },
      });
    } else {
      user = await prisma.user.create({
        data: {
          email,
          googleId,
          displayName,
          avatarUrl,
          lastActiveAt: new Date(),
          ...(refreshToken ? { googleRefreshToken: refreshToken } : {}),
        },
      });
    }
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastActiveAt: new Date(),
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(refreshToken ? { googleRefreshToken: refreshToken } : {}),
      },
    });
  }

  // Consume any pending, unexpired invitations addressed to this email.
  // Creating a membership for the inviting org skips the otherwise-empty
  // /onboarding redirect for new sign-ups who were invited rather than
  // self-served.
  const pendingInvites = await prisma.invitation.findMany({
    where: { email, expiresAt: { gt: new Date() } },
  });
  for (const invite of pendingInvites) {
    const newMember = await prisma.orgMember
      .create({
        data: {
          orgId: invite.orgId,
          userId: user.id,
          role: invite.role,
        },
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
        console.warn("[chat] failed to auto-join invited OrgMember to #general", { orgId: newMember.orgId, userId: newMember.userId }, err);
      }
    }
    await prisma.invitation
      .delete({ where: { id: invite.id } })
      .catch(() => undefined);
  }

  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      expiresAt,
    },
  });

  const response = NextResponse.redirect(new URL("/", origin));
  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  response.cookies.delete(OAUTH_STATE_COOKIE);
  return response;
}
