import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { openSecret } from "@/lib/crypto/vault";
import { exchangeForemanClaudeCode } from "@/lib/ai/foreman-claude-subscription";

/**
 * Complete Foreman's OWN per-org Claude-subscription OAuth: read the sealed
 * PKCE cookie (verifier + state), exchange the pasted code/URL for tokens,
 * seal + store them on ForemanAiSettings, then delete the one-shot cookie.
 * Gated by ORG_MANAGE_SETTINGS.
 */

const PKCE_COOKIE = "foreman_claude_oauth_pkce";

const bodySchema = z.object({ code: z.string().min(1).max(8192) }).strict();

type RouteParams = { params: Promise<{ orgId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
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

    const { code } = bodySchema.parse(await request.json());

    const pkceCookie = request.cookies.get(PKCE_COOKIE);
    if (!pkceCookie?.value) {
      return success(
        { success: false, error: "OAuth session expired. Please start again." },
      );
    }

    let verifier: string;
    let state: string;
    try {
      const pkce = JSON.parse(openSecret(pkceCookie.value)) as {
        verifier: string;
        state: string;
      };
      verifier = pkce.verifier;
      state = pkce.state;
    } catch {
      const bad = success({
        success: false,
        error: "Invalid OAuth session. Please start again.",
      });
      bad.cookies.delete(PKCE_COOKIE);
      return bad;
    }

    const result = await exchangeForemanClaudeCode(
      orgId,
      code,
      verifier,
      state,
      ctx.userId,
    );

    const response = success(result);
    response.cookies.delete(PKCE_COOKIE);
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
