import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { setAnthropicKey } from "@/lib/ai/ai-credentials";

/**
 * Per-org Anthropic API key.
 *   POST   { apiKey } → seal + store the key (setAnthropicKey selects the provider).
 *   DELETE → clear the stored key (nulls the sealed column).
 *
 * Gated by ORG_MANAGE_SETTINGS, mirroring the claude-subscription routes. The key
 * is NEVER echoed back — POST returns { configured: true }.
 */

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({
  apiKey: z.string().trim().min(1, "API key is required"),
});

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

    const { apiKey } = bodySchema.parse(await request.json());
    await setAnthropicKey(orgId, apiKey, ctx.userId);

    return success({ configured: true });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
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

    await prisma.orgAiSettings.updateMany({
      where: { orgId },
      data: { anthropicApiKey: Prisma.DbNull, updatedById: ctx.userId },
    });

    return success({ configured: false });
  } catch (error) {
    return handleApiError(error);
  }
}
