import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { rateLimit, getRateLimitKey } from "@/lib/rate-limit/bucket";

/**
 * Public, pre-auth brand discovery for the login page. Given an org slug,
 * returns ONLY non-sensitive white-label branding so the login surface can
 * render the org's name/logo/tagline/agent and apply its default skin BEFORE
 * authentication. An unknown slug returns all-null branding (the page degrades
 * to the deployment default). Returns NO secrets — mirrors the SSO-status
 * endpoint's safety profile.
 */
type RouteParams = { params: Promise<{ orgSlug: string }> };

const EMPTY = {
  brandName: null as string | null,
  logoUrl: null as string | null,
  tagline: null as string | null,
  agentName: null as string | null,
  defaultSkinId: null as string | null,
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { orgSlug } = await params;

  // Brake enumeration of which slugs exist / are branded.
  const rl = rateLimit(getRateLimitKey(request, "orgs.brand"), {
    capacity: 30,
    refillPerSecond: 2,
  });
  if (!rl.allowed) {
    return NextResponse.json(EMPTY, { status: 429 });
  }

  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: {
      brandName: true,
      logoUrl: true,
      tagline: true,
      agentName: true,
      defaultSkinId: true,
    },
  });

  return NextResponse.json({
    brandName: org?.brandName ?? null,
    logoUrl: org?.logoUrl ?? null,
    tagline: org?.tagline ?? null,
    agentName: org?.agentName ?? null,
    defaultSkinId: org?.defaultSkinId ?? null,
  });
}
