import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { getAiProviderStatus } from "@/lib/ai/ai-credentials";
import { success, handleApiError } from "@/lib/api-helpers";
import { pruneToProjects, readAutomationConfig, validateEnableGate } from "@/lib/feedback/automation-config";

type RouteParams = { params: Promise<{ orgId: string }> };

const configSchema = z.object({
  autoRemediation: z.object({
    enabled: z.boolean(),
    projectIds: z.array(z.string().uuid()),
    defaultProjectId: z.string().uuid().nullable(),
  }),
  autonomousDelivery: z.object({
    notify: z
      .object({ parked: z.boolean(), shipped: z.boolean() })
      .default({ parked: true, shipped: true }),
    enabled: z.boolean(),
    projectIds: z.array(z.string().uuid()),
  }),
});

function badRequest(error: string) {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/** Read the org's feedback-automation config (auto-triage + autonomous delivery,
 *  both now multi-project) + the projects available for the pickers. Gated on
 *  ORG_UPDATE (this is org admin surface). */
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
      ...pruneToProjects(readAutomationConfig(org.settings), new Set(projects.map((p) => p.id))),
      projects,
      aiConnected,
      aiProvider: ai.provider,
      claudeSubscription: ai.claudeOAuth,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** Update the config — merges `autoRemediation` + `autonomousDelivery` into
 *  `Organization.settings` without touching other settings keys. */
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

    // Can't enable an automation without a valid project scope (and, for
    // auto-triage, a default project drawn from that scope).
    const gateReason = validateEnableGate(data);
    if (gateReason) return badRequest(gateReason);

    // Every referenced project id must be a live project in THIS org — never
    // triage/deliver into a project that doesn't exist, is archived, or
    // belongs to someone else's org. Single query, reused across all three
    // fields.
    const referencedIds = [
      ...data.autoRemediation.projectIds,
      ...data.autonomousDelivery.projectIds,
      ...(data.autoRemediation.defaultProjectId ? [data.autoRemediation.defaultProjectId] : []),
    ];
    if (referencedIds.length > 0) {
      const orgProjects = await prisma.project.findMany({
        where: { orgId, archived: false },
        select: { id: true },
      });
      const orgProjectIds = new Set(orgProjects.map((p) => p.id));
      const unknownId = referencedIds.find((id) => !orgProjectIds.has(id));
      if (unknownId) {
        return badRequest("One or more selected projects were not found in this organization.");
      }
    }

    const existing = (org.settings as Record<string, unknown>) ?? {};
    const nextSettings: Record<string, unknown> = {
      ...existing,
      autoRemediation: data.autoRemediation,
      autonomousDelivery: data.autonomousDelivery,
    };
    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: nextSettings as never },
    });

    return success({
      autoRemediation: data.autoRemediation,
      autonomousDelivery: data.autonomousDelivery,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
