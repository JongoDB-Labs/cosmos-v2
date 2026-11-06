import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getIpAddress } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { resolveSenderOrg } from "@/lib/auth/sender-org";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { createPasswordResetToken } from "@/lib/auth/password-reset";
import { sendPasswordResetEmail } from "@/lib/integrations/invitation-email";
import { logAudit } from "@/lib/audit";
import { maskEmail, truncateForLog } from "@/lib/auth/mask-email";

const schema = z.object({
  email: z.string().email().max(320),
  // Optional org context from /login?org=<slug> — used only to pick the org's
  // email-delivery config (and never to confirm/deny membership to the caller).
  orgSlug: z.string().max(200).optional(),
});

/**
 * What became of a reset request. Recorded for the OPERATOR only — every one of
 * these returns the same generic body to the caller, so naming them here never
 * becomes an enumeration oracle.
 *
 * This exists because the absence of a signal used to be ambiguous. The route
 * logged only on send failure, so "no log line" meant *mail went out*, *no
 * account matched*, and *nobody ever submitted the form* equally well. A member
 * reported a reset that never arrived and there was no way to tell which of the
 * three had happened — see the reset-flow tests, which pin each outcome.
 */
type ResetOutcome =
  | "sent"
  | "send_failed"
  | "lookup_failed"
  | "no_such_email"
  | "sso_only"
  | "inactive"
  | "throttled";

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

  let outcome: ResetOutcome = "no_such_email";
  let org: Awaited<ReturnType<typeof resolveSenderOrg>> = null;
  let userId: string | undefined;
  // Why a send failed, verbatim, for the operator line and the audit row. Never
  // returned to the caller.
  let detail: string | undefined;

  // Per-account brake so nobody can flood a specific inbox with reset mail.
  const acctRl = rateLimit(`pwreset:acct:${normalized}`, {
    capacity: 3,
    refillPerSecond: 0.02,
  });

  if (!acctRl.allowed) {
    outcome = "throttled";
  } else {
    try {
      // The ELIGIBLE account decides whether mail goes out, filtered in SQL
      // exactly as before. `User.email` carries no unique constraint, so an
      // address can legitimately match several rows (a deactivated row kept for
      // attribution plus a current one, say). Classifying from an unfiltered
      // findFirst would let an ineligible row win the race and refuse a reset
      // to a perfectly good account — the diagnosis below must never be able to
      // change that decision.
      const eligible = await prisma.user.findFirst({
        where: {
          email: { equals: normalized, mode: "insensitive" },
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

      // Only when nothing eligible matched do we look again to NAME why, which
      // is purely diagnostic and reached only on the no-mail paths.
      const others = eligible
        ? []
        : await prisma.user.findMany({
            where: { email: { equals: normalized, mode: "insensitive" } },
            select: {
              id: true,
              passwordHash: true,
              isBot: true,
              deactivatedAt: true,
              memberships: {
                select: { org: { select: { id: true, slug: true } } },
              },
            },
          });

      // Choose the org whose email-delivery config sends the mail. Membership
      // first, then the org that invited them -- see resolveSenderOrg for why
      // that fallback is the whole point rather than a nicety. Resolved even
      // when no account matched, so an invited-but-not-yet-joined address still
      // attributes its audit row somewhere.
      org = await resolveSenderOrg({
        email: normalized,
        orgSlug,
        memberships: eligible?.memberships ?? others[0]?.memberships ?? [],
      });

      if (eligible) {
        userId = eligible.id;
        const token = createPasswordResetToken(eligible);
        const resetUrl = `${getPublicOrigin(request)}/reset-password?token=${encodeURIComponent(token)}`;
        try {
          await sendPasswordResetEmail({
            orgId: org?.id,
            toEmail: eligible.email,
            resetUrl,
          });
          outcome = "sent";
        } catch (e) {
          // Swallowed toward the CALLER — surfacing it would reveal the
          // account exists. The operator gets it below: the caller and the
          // operator are different audiences, and staying silent to both is
          // what made this invisible.
          outcome = "send_failed";
          detail = e instanceof Error ? e.message : String(e);
        }
      } else if (others.length === 0) {
        outcome = "no_such_email";
      } else {
        userId = others[0].id;
        // Most specific reason first, so the answer doesn't depend on which of
        // several rows a query happened to return.
        outcome = others.some((u) => u.passwordHash && (u.isBot || u.deactivatedAt))
          ? "inactive"
          : // SSO/Google-only: there is no password to reset. Correct to send
            // nothing, but it is the outcome most often reported as "broken",
            // so it is named rather than left silent.
            "sso_only";
      }
    } catch (e) {
      // Never surface lookup errors to the caller either — stay indistinguishable.
      outcome = "lookup_failed";
      detail = e instanceof Error ? e.message : String(e);
    }
  }

  // ONE operator line per request, whatever happened. "sent" is logged too: a
  // success signal is what makes the absence of one meaningful.
  //
  // The address is logged in full ONLY when it matched a real account, which is
  // the case an operator is actually asked to explain and whose address we
  // already hold in `users` and in the audit row below. Anything else is an
  // arbitrary string from an unauthenticated caller, so it is masked: without
  // that, anyone could spray third-party addresses into the operator's logs by
  // POSTing this endpoint. Note the caller cannot read any of this — the
  // response is byte-identical on every path — so this is about not retaining
  // other people's PII, not about enumeration.
  const where = org ? `org ${org.slug}, via ${org.source}` : "no org and no pending invitation";
  const who = userId ? normalized : maskEmail(normalized);
  console.info(
    `[password-reset] ${outcome} for ${who} (${where})` +
      `${userId ? ` user=${userId}` : ""}${detail ? `: ${truncateForLog(detail)}` : ""}`,
  );

  // Durable trail, for the org the account actually BELONGS to — a membership
  // the org can see for itself, never the pending-invitation fallback.
  //
  // resolveSenderOrg deliberately falls back to whoever invited the address,
  // because that is the right org to send the mail AS. It is the wrong basis
  // for a tenant-readable audit row: an invited address may already have an
  // account elsewhere, and attributing its outcome (or its userId) to the
  // inviting org would put a non-member's state into that org's log. An
  // address with no membership is covered by the operator line, which records
  // every outcome whatever org resolved — so nothing diagnostic is lost.
  //
  // AuditLog.orgId is NOT nullable, so there is nowhere else such a row could go.
  const auditOrg = org && (org.source === "membership" || org.source === "named") ? org : null;
  if (auditOrg) {
    try {
      await logAudit({
        orgId: auditOrg.id,
        userId,
        action: "auth.password_reset.requested",
        entity: "user",
        entityId: userId,
        // `detail` is upstream error text — not ours, not bounded, and of no
        // use to a tenant reading their audit log. It stays in the operator
        // line only.
        metadata: { outcome, email: normalized },
        ipAddress: ip,
      });
    } catch (e) {
      // An audit write must never turn a reset into a visible error, and must
      // never change what the caller sees.
      // eslint-disable-next-line no-restricted-syntax -- operator-facing, best-effort
      console.error(`[password-reset] audit write failed for ${normalized}:`, e);
    }
  }

  return NextResponse.json({ ok: true });
}
