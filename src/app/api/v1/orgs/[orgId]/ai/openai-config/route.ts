import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { setOpenAiConfig } from "@/lib/ai/ai-credentials";

/**
 * Per-org OpenAI-COMPATIBLE endpoint config (e.g. https://api.openai.com/v1 or a
 * self-hosted gateway).
 *   POST   { apiKey, baseUrl, model } → seal key + store endpoint (selects provider).
 *   DELETE → clear the stored config (nulls the sealed column).
 *
 * Gated by ORG_MANAGE_SETTINGS, mirroring the claude-subscription routes. The key
 * is NEVER echoed back — POST returns { configured: true } + the non-secret echo.
 */

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({
  apiKey: z.string().trim().min(1, "API key is required"),
  baseUrl: z.string().trim().url("A valid base URL is required"),
  model: z.string().trim().min(1, "Model is required"),
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

    const { apiKey, baseUrl, model } = bodySchema.parse(await request.json());
    await setOpenAiConfig(orgId, { apiKey, baseUrl, model }, ctx.userId);

    return success({ configured: true, baseUrl, model });
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
      data: { openaiApiKey: Prisma.DbNull, updatedById: ctx.userId },
    });

    return success({ configured: false });
  } catch (error) {
    return handleApiError(error);
  }
}
