// src/lib/ai/policy/index.ts
//
// The per-org AGENT POLICY loader (design D9/§8). Turns the AgentPolicy store (or its
// ABSENCE) into the clean `AgentPolicy` shape the loop's middle gate (`checkAgentPolicy`)
// consumes — the MIDDLE of `RBAC ∩ AgentPolicy ∩ Classification` (narrowest wins).
//
// THE LOAD-BEARING DEFAULT: a MISSING row (no policy) ⇒ PERMISSIVE: all tools/domains
// allowed, no arg bounds — EXACTLY today's behavior. So existing orgs are unaffected until
// an admin opts in. The two ALLOWLIST axes (tools, projects) model the tri-state as a flag +
// array (Prisma has no nullable scalar list); this loader collapses that to the clean
// `string[] | null` (null = "no restriction") the enforcer reads.

import { prisma } from "@/lib/db/client";

/**
 * The normalized per-org agent policy — the shape `checkAgentPolicy` consumes (NOT the raw
 * Prisma row). The two ALLOWLIST axes are `string[] | null` where `null` = "no restriction
 * on this axis" (the permissive default); an explicit array opts into a SUBSET (and `[]`
 * means NONE).
 */
export interface AgentPolicy {
  /** AXIS 1 — tool ALLOWLIST, or `null` for "all tools allowed" (default). `[]` = none. */
  allowedTools: string[] | null;
  /** AXIS 1 — tool DENYLIST (always applied; wins over the allowlist). `[]` = none denied. */
  deniedTools: string[];
  /** AXIS 2 — denied coarse data-domains (TOOL_DOMAIN map). `[]` = none denied. */
  deniedDomains: string[];
  /** AXIS 3 — clamp a `limit`/`maxResults` arg above this; `null` = no clamp. */
  maxResultLimit: number | null;
  /** AXIS 3 — project-scope ALLOWLIST, or `null` for "any projectId allowed" (default). */
  allowedProjectIds: string[] | null;
}

/** The default a MISSING row resolves to — PERMISSIVE (no restriction on any axis), preserving
 *  current behavior. Every check in {@link import("./enforce").checkAgentPolicy} is a no-op
 *  against this. */
export const PERMISSIVE_AGENT_POLICY: AgentPolicy = {
  allowedTools: null,
  deniedTools: [],
  deniedDomains: [],
  maxResultLimit: null,
  allowedProjectIds: null,
};

/**
 * Load (and normalize) an org's agent policy. A missing row ⇒ {@link PERMISSIVE_AGENT_POLICY}
 * (no restriction) — so an org that never opted in keeps today's behavior.
 */
export async function getAgentPolicy(orgId: string): Promise<AgentPolicy> {
  const row = await prisma.agentPolicy.findUnique({ where: { orgId } });
  if (!row) return { ...PERMISSIVE_AGENT_POLICY };
  return normalizeAgentPolicy(row);
}

/**
 * Collapse a raw AgentPolicy row into the clean AgentPolicy shape: each `<flag>Set` + array
 * pair becomes `string[] | null` (false ⇒ null ⇒ "no restriction"; true ⇒ the explicit subset).
 */
export function normalizeAgentPolicy(row: {
  allowedToolsSet: boolean;
  allowedTools: string[];
  deniedTools: string[];
  deniedDomains: string[];
  maxResultLimit: number | null;
  allowedProjectIdsSet: boolean;
  allowedProjectIds: string[];
}): AgentPolicy {
  return {
    allowedTools: row.allowedToolsSet ? row.allowedTools : null,
    deniedTools: row.deniedTools,
    deniedDomains: row.deniedDomains,
    maxResultLimit: row.maxResultLimit,
    allowedProjectIds: row.allowedProjectIdsSet ? row.allowedProjectIds : null,
  };
}
