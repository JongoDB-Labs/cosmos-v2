import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";

/**
 * Public, pre-auth SSO discovery for the login page. Given an org slug, reports
 * whether that org offers SSO and whether it's *enforced* (gov: SSO-only, Google
 * rejected). Returns NO secrets — only the two booleans the login UI needs to
 * decide which buttons to render. An unknown slug or a disabled connection both
 * report `{ enabled: false, enforced: false }` so the page degrades to Google.
 *
 * `enforced` here is the connection's own flag (the gov SSO-only intent). The
 * Google callback independently re-checks `tenantClass==="GOV" && enabled &&
 * enforced` before minting a session — this endpoint is a UI hint, never a trust
 * boundary.
 */

type RouteParams = { params: Promise<{ orgSlug: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { orgSlug } = await params;

  // Brake enumeration of which orgs have SSO configured.
  const rl = rateLimit(getRateLimitKey(request, "auth.sso.status"), {
    capacity: 30,
    refillPerSecond: 2,
  });
  if (!rl.allowed) {
    return NextResponse.json({ enabled: false, enforced: false }, { status: 429 });
  }

  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: {
      tenantClass: true,
      idpConnection: { select: { enabled: true, enforced: true } },
    },
  });

  const conn = org?.idpConnection;
  const enabled = Boolean(conn?.enabled);
  // Only a GOV tenant can *enforce* SSO-only (hide Google). A commercial tenant
  // with enforced=true still keeps Google available — mirrors the callback guard,
  // which only 403s gov tenants. This keeps the UI and the guard in lockstep.
  const enforced =
    enabled && Boolean(conn?.enforced) && org?.tenantClass === "GOV";

  return NextResponse.json({ enabled, enforced });
}
