import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getAgentPolicy } from "@/lib/ai/policy";
import { KNOWN_DOMAINS } from "@/lib/ai/policy/domains";

// The per-org AGENT POLICY (design D9/§8) — the MIDDLE gate of RBAC ∩ AgentPolicy ∩
// Classification. A TENANT-ADMIN surface gated by AGENT_POLICY_MANAGE: read/update the 3
// axes (tools, domain, args). The ABSENCE of a row ⇒ PERMISSIVE (everything runs) — the
// load-bearing default. Validation: tool names are strings; domains ∈ KNOWN_DOMAINS;
// maxResultLimit ≥ 1. Never returns OrgMember.permissions (no BigInt in the payload).

const toolArray = z.array(z.string().min(1).max(200));

const patchSchema = z
  .object({
    // AXIS 1 — tri-state allowlist: omit ⇒ unchanged; null ⇒ "all tools" (allowlist off);
    // array ⇒ explicit subset.
    allowedTools: toolArray.nullable().optional(),
    deniedTools: toolArray.optional(),
    // AXIS 2 — denied coarse domains; each must be a KNOWN domain.
    deniedDomains: z.array(z.enum(KNOWN_DOMAINS)).optional(),
    // AXIS 3 — limit cap (≥1) or null to clear; project-scope tri-state allowlist.
    maxResultLimit: z.number().int().min(1).nullable().optional(),
    allowedProjectIds: z.array(z.string().min(1).max(200)).nullable().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ orgId: string }> };

async function loadOrg(orgId: string) {
  return prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
}

function payload(policy: Awaited<ReturnType<typeof getAgentPolicy>>) {
  // The known-domain set feeds the UI's domain picker; the policy is the source of truth.
  // Never includes OrgMember.permissions (no BigInt in the response).
  return {
    knownDomains: KNOWN_DOMAINS,
    allowedTools: policy.allowedTools,
    deniedTools: policy.deniedTools,
    deniedDomains: policy.deniedDomains,
    maxResultLimit: policy.maxResultLimit,
    allowedProjectIds: policy.allowedProjectIds,
  };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await loadOrg(orgId);
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.AGENT_POLICY_MANAGE);

    return success(payload(await getAgentPolicy(orgId)));
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
    requirePermission(ctx, Permission.AGENT_POLICY_MANAGE);

    const data = patchSchema.parse(await request.json());

    // Map the tri-state allowlists to the stored (flag + array) shape:
    //   null ⇒ flag OFF (no restriction, array cleared); array ⇒ flag ON with that subset;
    //   omitted ⇒ unchanged.
    const allowedToolsFields =
      data.allowedTools === undefined
        ? {}
        : data.allowedTools === null
          ? { allowedToolsSet: false, allowedTools: [] }
          : { allowedToolsSet: true, allowedTools: data.allowedTools };
    const allowedProjectsFields =
      data.allowedProjectIds === undefined
        ? {}
        : data.allowedProjectIds === null
          ? { allowedProjectIdsSet: false, allowedProjectIds: [] }
          : { allowedProjectIdsSet: true, allowedProjectIds: data.allowedProjectIds };

    const mutable = {
      ...allowedToolsFields,
      ...allowedProjectsFields,
      ...(data.deniedTools !== undefined && { deniedTools: data.deniedTools }),
      ...(data.deniedDomains !== undefined && { deniedDomains: data.deniedDomains }),
      ...(data.maxResultLimit !== undefined && { maxResultLimit: data.maxResultLimit }),
    };

    const updated = await prisma.agentPolicy.upsert({
      where: { orgId },
      create: { orgId, ...mutable },
      update: mutable,
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "agent_policy.updated",
      entity: "agent_policy",
      entityId: updated.id,
      metadata: { changes: Object.keys(data).join(", ") } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(payload(await getAgentPolicy(orgId)));
  } catch (error) {
    return handleApiError(error);
  }
}
