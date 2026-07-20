import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getForemanHarnessSettings } from "@/lib/foreman/harness-settings";

/**
 * Per-org config for the Foreman build harness (skills + project system prompt +
 * project MCP tools loaded into every build agent). Mirrors the foreman/supervisor
 * route: GET current settings (or the safe defaults), PUT to upsert. Gated by
 * ORG_MANAGE_SETTINGS — the same steering privilege as the rest of the Foreman
 * console. No secrets, just config.
 */
type RouteParams = { params: Promise<{ orgId: string }> };

async function gate(
  params: RouteParams["params"],
): Promise<{ orgId: string; userId: string } | { error: Response }> {
  const { orgId } = await params;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
  return { orgId, userId: ctx.userId };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    return success(await getForemanHarnessSettings(g.orgId));
  } catch (error) {
    return handleApiError(error);
  }
}

const putSchema = z.object({
  enabled: z.boolean(),
  systemPromptAppend: z.string().max(4000).nullable(),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    const body = putSchema.parse(await request.json());
    await prisma.foremanHarnessSettings.upsert({
      where: { orgId: g.orgId },
      create: { orgId: g.orgId, ...body, updatedById: g.userId },
      update: { ...body, updatedById: g.userId },
    });
    return success(await getForemanHarnessSettings(g.orgId));
  } catch (error) {
    return handleApiError(error);
  }
}
