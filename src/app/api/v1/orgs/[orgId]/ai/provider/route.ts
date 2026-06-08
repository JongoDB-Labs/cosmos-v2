import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import {
  getAiProviderStatus,
  setActiveProvider,
  type AiProvider,
} from "@/lib/ai/ai-credentials";

/**
 * AI provider selector for the org.
 *   GET  → getAiProviderStatus (which provider is active + which are configured).
 *   POST → setActiveProvider ({ provider }).
 *
 * Gated by ORG_MANAGE_SETTINGS, mirroring the claude-subscription routes
 * (getAuthContext + success/handleApiError). Never echoes secrets.
 */

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({
  provider: z.enum(["claude-oauth", "anthropic", "openai"]),
});

export async function GET(_request: NextRequest, { params }: RouteParams) {
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

    return success(await getAiProviderStatus(orgId));
  } catch (error) {
    return handleApiError(error);
  }
}

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

    const { provider } = bodySchema.parse(await request.json());
    await setActiveProvider(orgId, provider as AiProvider, ctx.userId);

    return success({ provider });
  } catch (error) {
    return handleApiError(error);
  }
}
