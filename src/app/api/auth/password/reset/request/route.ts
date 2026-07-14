import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getIpAddress } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { createPasswordResetToken } from "@/lib/auth/password-reset";
import { sendPasswordResetEmail } from "@/lib/integrations/invitation-email";

const schema = z.object({
  email: z.string().email().max(320),
  // Optional org context from /login?org=<slug> — used only to pick the org's
  // email-delivery config (and never to confirm/deny membership to the caller).
  orgSlug: z.string().max(200).optional(),
});

/**
 * Self-service "forgot password" — begin a reset for an email/password account.
 *
 * SECURITY: this endpoint MUST NOT reveal whether an email exists (or whether it
 * has a password vs. being SSO/Google-only). Every path returns the SAME generic
 * `{ ok: true }`; only a real email/password account actually gets mail. It is
 * rate-limited per IP and per target email so it can't be used to spam an inbox
 * or enumerate accounts by timing/volume.
 */
export async function POST(request: NextRequest) {
  const ip = getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`pwreset:${ip}`, { capacity: 5, refillPerSecond: 0.05 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait and try again." },
      { status: 429 },
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  // A malformed body still gets the generic OK — never surface validation detail.
  if (!parsed.success) return NextResponse.json({ ok: true });
  const { email, orgSlug } = parsed.data;
  const normalized = email.trim().toLowerCase();

  // Per-account brake so nobody can flood a specific inbox with reset mail.
  const acctRl = rateLimit(`pwreset:acct:${normalized}`, {
    capacity: 3,
    refillPerSecond: 0.02,
  });
  if (!acctRl.allowed) return NextResponse.json({ ok: true });

  try {
    const user = await prisma.user.findFirst({
      where: {
        email: { equals: normalized, mode: "insensitive" },
        // SSO/Google-only accounts have no passwordHash → nothing to reset.
        passwordHash: { not: null },
        isBot: false,
        deactivatedAt: null,
      },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        passwordSetAt: true,
        memberships: {
          select: { org: { select: { id: true, slug: true } } },
        },
      },
    });

    if (user) {
      // Choose the org whose email-delivery config sends the mail: the org named
      // on the login screen when the user belongs to it, else any membership,
      // else undefined (falls back to the deployment-wide env config).
      const orgs = user.memberships.map((m) => m.org);
      const org =
        (orgSlug ? orgs.find((o) => o.slug === orgSlug) : undefined) ??
        orgs[0] ??
        null;

      const token = createPasswordResetToken(user);
      const resetUrl = `${getPublicOrigin(request)}/reset-password?token=${encodeURIComponent(token)}`;

      try {
        await sendPasswordResetEmail({
          orgId: org?.id,
          toEmail: user.email,
          resetUrl,
        });
      } catch {
        // Swallow — a send failure or missing config must never leak to the
        // caller (it would reveal the account exists).
      }
    }
  } catch {
    // Never surface lookup errors either — stay indistinguishable.
  }

  return NextResponse.json({ ok: true });
}
