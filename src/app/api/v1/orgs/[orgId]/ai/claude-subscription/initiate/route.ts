import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { sealSecret } from "@/lib/crypto/vault";
import { initiateClaudeOAuth } from "@/lib/ai/claude-subscription";

/**
 * Begin the per-org Claude-subscription OAuth (PKCE) flow. Mints the verifier +
 * state, stashes them SEALED in a short-lived httpOnly cookie the exchange route
 * validates against, and returns the Claude authorize URL the admin visits.
 *
 * Gated by ORG_MANAGE_SETTINGS — connecting a subscription is a tenant-admin act.
 */

const PKCE_COOKIE = "claude_oauth_pkce";
const PKCE_COOKIE_MAX_AGE = 600; // 10 minutes

type RouteParams = { params: Promise<{ orgId: string }> };

export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);

    const { url, verifier, state } = initiateClaudeOAuth();

    const response = success({ url });
    response.cookies.set(
      PKCE_COOKIE,
      sealSecret(JSON.stringify({ verifier, state })),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: PKCE_COOKIE_MAX_AGE,
      },
    );
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
