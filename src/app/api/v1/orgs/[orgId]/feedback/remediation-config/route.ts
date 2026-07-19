import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { getAiProviderStatus } from "@/lib/ai/ai-credentials";
import { getForemanClaudeStatus } from "@/lib/ai/foreman-claude-subscription";
import { publishToOrg } from "@/lib/realtime/broker";
import { success, handleApiError } from "@/lib/api-helpers";
import { pruneToProjects, readAutomationConfig, validateEnableGate } from "@/lib/feedback/automation-config";
import {
  normalizeIntakePolicyInput,
  readIntakePolicy,
  serializeIntakePolicy,
} from "@/lib/feedback/intake-policy";

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
    // Parallel build workers — see AutonomousDeliveryCfg.workers.
    workers: z.number().int().min(1).max(3).default(2),
    enabled: z.boolean(),
    projectIds: z.array(z.string().uuid()),
  }),
  // Org intake policy (Phase 3c) — optional so the console's pause/resume PUT
  // (which sends only the two automation blocks) never clobbers it. Loosely
  // typed here and clamped by `normalizeIntakePolicyInput`, which owns the
  // per-field validation + safe defaults.
  intakePolicy: z.unknown().optional(),
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

    // AI-connection gate (COSMOS-105): auto-triage runs on FOREMAN's own Claude
    // subscription (getForemanClaudeCreds in the remediation executor), NOT the
    // org's general-purpose provider — so the gate must read Foreman's
    // connection, not the org's. Gating on the org left the automation inert
    // ("Connect a Claude subscription") even when Foreman's Claude was connected.
    // `ai.provider` is still surfaced purely as a display hint for the form.
    const ai = await getAiProviderStatus(orgId);
    const foreman = await getForemanClaudeStatus(orgId);
    const aiConnected = foreman.connected;

    return success({
      ...pruneToProjects(readAutomationConfig(org.settings), new Set(projects.map((p) => p.id))),
      // Normalized org intake policy (Phase 3c) with safe defaults, for the
      // policy editor.
      intakePolicy: readIntakePolicy(org.settings),
      projects,
      aiConnected,
      aiProvider: ai.provider,
      claudeSubscription: foreman,
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

    // Merge the intake policy only when the caller sent one — the console's
    // pause/resume omits it, and absent must never reset it to defaults. Stored
    // under the same keys the remediation loop reads, so the change takes effect
    // on the next run.
    let savedPolicy = readIntakePolicy(org.settings);
    if (data.intakePolicy !== undefined) {
      savedPolicy = normalizeIntakePolicyInput(data.intakePolicy);
      Object.assign(nextSettings, serializeIntakePolicy(savedPolicy));
    }

    await prisma.organization.update({
      where: { id: orgId },
      data: { settings: nextSettings as never },
    });

    // Live-update every open settings view in this org (COSMOS-130). Best-effort;
    // org-scoped by the topic so it never leaks across tenants.
    try {
      publishToOrg(orgId, "settings.updated", { orgId, section: "automation" });
    } catch {
      /* never let a broker error break the update response */
    }

    return success({
      autoRemediation: data.autoRemediation,
      autonomousDelivery: data.autonomousDelivery,
      intakePolicy: savedPolicy,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
