import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { getAiProviderStatus } from "@/lib/ai/ai-credentials";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

const configSchema = z.object({
  enabled: z.boolean(),
  targetProjectId: z.string().uuid().nullable(),
});

/** Read the org's auto-remediation config + the projects available as the
 *  delivery target (for the settings picker). Gated on ORG_UPDATE (this is org
 *  admin surface). */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, settings: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const cfg = ((org.settings as Record<string, unknown>)?.autoRemediation ?? {}) as {
      enabled?: boolean;
      targetProjectId?: string;
    };
    const projects = await prisma.project.findMany({
      where: { orgId, archived: false },
      select: { id: true, key: true, name: true },
      orderBy: { key: "asc" },
    });

    // AI-connection gate (per maintainer directive): the loop only runs with a
    // connected model provider. Surface it so the form can point the admin at
    // Settings → AI instead of silently no-op'ing on the heuristic.
    const ai = await getAiProviderStatus(orgId);
    const aiConnected =
      ai.claudeOAuth.connected || ai.anthropic.configured || ai.openai.configured;

    return success({
      enabled: cfg.enabled === true,
      targetProjectId: cfg.targetProjectId ?? null,
      projects,
      aiConnected,
      aiProvider: ai.provider,
      claudeSubscription: ai.claudeOAuth,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Update the config — merges `autoRemediation` into `Organization.settings`
 *  without touching other settings keys. */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, settings: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const data = configSchema.parse(await request.json());

    // Can't enable without a target, and the target must be a live project in
    // this org — never deliver into a project that doesn't exist / is archived.
    if (data.enabled) {
      if (!data.targetProjectId) {
        return new Response(
          JSON.stringify({ error: "A target project is required to enable auto-remediation." }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const target = await prisma.project.findFirst({
        where: { id: data.targetProjectId, orgId, archived: false },
        select: { id: true },
      });
      if (!target) {
        return new Response(
          JSON.stringify({ error: "Target project not found in this organization." }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const existing = (org.settings as Record<string, unknown>) ?? {};
    const nextSettings = {
      ...existing,
      autoRemediation: {
        enabled: data.enabled,
        targetProjectId: data.targetProjectId,
      },
    };
    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: nextSettings as never },
    });

    return success({ enabled: data.enabled, targetProjectId: data.targetProjectId });
  } catch (error) {
    return handleApiError(error);
  }
}
