import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { govGuardrailViolation } from "@/lib/runtime-config/guardrails";
import { allConnectorProviders } from "@/lib/ai/connectors";

// The per-org RUNTIME CONFIG (design §8) — connector enablement + breadth/mcp toggles, a
// TENANT-ADMIN surface gated by INTEGRATION_MANAGE. tenantClass is READ-ONLY here: a
// tenant-admin can NEVER flip it (that's the platform-owner /api/internal route). And a GOV
// org's PATCH cannot re-enable breadth/mcp or list a commercial-only connector — the gov
// guardrails are enforced SERVER-SIDE (rejected 400), independent of the UI.

const patchSchema = z
  .object({
    // tri-state: omit ⇒ unchanged; null ⇒ "all enabled" (allowlist off); array ⇒ subset.
    enabledConnectors: z.array(z.string().min(1).max(100)).nullable().optional(),
    breadthEnabled: z.boolean().optional(),
    mcpEnabled: z.boolean().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ orgId: string }> };

async function loadOrg(orgId: string) {
  return prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true, tenantClass: true },
  });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await loadOrg(orgId);
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const config = await getRuntimeConfig(orgId);
    // tenantClass is surfaced READ-ONLY (the badge); the available providers feed the UI's
    // enablement toggles. Never includes OrgMember.permissions (no BigInt in the payload).
    return success({
      tenantClass: org.tenantClass,
      availableConnectors: allConnectorProviders(),
      enabledConnectors: config.enabledConnectors,
      breadthEnabled: config.breadthEnabled,
      mcpEnabled: config.mcpEnabled,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await loadOrg(orgId);
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.INTEGRATION_MANAGE);

    const data = patchSchema.parse(await request.json());

    // ── GOV GUARDRAIL (server-side, independent of the UI) ─────────────────────────
    // A GOV org's PATCH may not enable breadth/mcp or list a commercial-only connector.
    // Reject 400 BEFORE writing anything — the guardrails are not a tenant-admin's to lift.
    const violation = govGuardrailViolation(org.tenantClass, data);
    if (violation) {
      return NextResponse.json({ error: violation }, { status: 400 });
    }

    // Map the tri-state to the stored shape: enabledConnectors === null ⇒ allowlist OFF
    // (all enabled); an array ⇒ allowlist ON with that subset; omitted ⇒ unchanged.
    const allowlistFields =
      data.enabledConnectors === undefined
        ? {}
        : data.enabledConnectors === null
          ? { allowlistEnabled: false, enabledConnectors: [] }
          : { allowlistEnabled: true, enabledConnectors: data.enabledConnectors };

    const updated = await prisma.orgRuntimeConfig.upsert({
      where: { orgId },
      create: {
        orgId,
        ...allowlistFields,
        ...(data.breadthEnabled !== undefined && { breadthEnabled: data.breadthEnabled }),
        ...(data.mcpEnabled !== undefined && { mcpEnabled: data.mcpEnabled }),
      },
      update: {
        ...allowlistFields,
        ...(data.breadthEnabled !== undefined && { breadthEnabled: data.breadthEnabled }),
        ...(data.mcpEnabled !== undefined && { mcpEnabled: data.mcpEnabled }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "runtime_config.updated",
      entity: "org_runtime_config",
      entityId: updated.id,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    const config = await getRuntimeConfig(orgId);
    return success({
      tenantClass: org.tenantClass,
      availableConnectors: allConnectorProviders(),
      enabledConnectors: config.enabledConnectors,
      breadthEnabled: config.breadthEnabled,
      mcpEnabled: config.mcpEnabled,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
