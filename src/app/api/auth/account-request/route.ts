import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getIpAddress } from "@/lib/api-helpers";
import { trustedClientIp } from "@/lib/auth/client-ip";
import { rateLimit } from "@/lib/rate-limit/bucket";
import { submitAccountRequest, recordSubmitOutcome } from "@/lib/auth/account-requests";

const schema = z.object({
  orgSlug: z.string().min(1).max(200),
  email: z.string().email().max(320),
  /** What the requester wants to say for themselves. Shown to the approver. */
  note: z.string().max(1000).optional(),
});

/**
 * Ask an org for an account. Unauthenticated by necessity — the whole point is
 * that the requester has no way in yet.
 *
 * SECURITY: this endpoint MUST NOT reveal whether the org exists, whether it
 * accepts requests, what its allowed domains are, or whether the address
 * already has an account. Every path returns the SAME generic `{ ok: true }`;
 * what actually happened goes to the operator log and, for a queued request,
 * the org's audit trail. Rate-limited per IP and per address so it can't be
 * used to flood an admin's queue or to probe policy by timing.
 *
 * Nothing here grants access. A queued row is a request; only an admin
 * approving it mints an invitation, and that goes through the one shared
 * account-minting path (see createOrgInvitation).
 */
export async function POST(request: NextRequest) {
  // Keyed by the address the edge proxy wrote (client-ip.ts), which a client
  // can't choose; the left-most X-Forwarded-For entry it can, which would buy
  // it a fresh limit per request.
  const ip = trustedClientIp(request.headers) ?? getIpAddress(request) ?? "unknown";
  const rl = rateLimit(`acctreq:${ip}`, { capacity: 5, refillPerSecond: 0.05 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait and try again." },
      { status: 429 },
    );
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  // A malformed body still gets the generic OK — never surface validation detail.
  if (!parsed.success) return NextResponse.json({ ok: true });
  const { orgSlug, email, note } = parsed.data;

  // Per-address brake, so one address cannot be used to spray an org's queue
  // even from many IPs.
  const acctRl = rateLimit(`acctreq:addr:${email.trim().toLowerCase()}`, {
    capacity: 3,
    refillPerSecond: 0.02,
  });
  if (!acctRl.allowed) return NextResponse.json({ ok: true });

  try {
    const result = await submitAccountRequest({ orgSlug, email, note, ipAddress: ip });
    await recordSubmitOutcome({ result, orgSlug, email, ipAddress: ip });
  } catch (e) {
    // Never surface a failure to the caller either — staying indistinguishable
    // is the point. The operator is a different audience.
    // eslint-disable-next-line no-restricted-syntax -- operator-facing, see above
    console.error(`[account-request] failed for org ${orgSlug}:`, e);
  }

  return NextResponse.json({ ok: true });
}
