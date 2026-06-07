// src/lib/runtime-config/index.ts
//
// The per-org RUNTIME CONFIG loader (design §8). Turns the OrgRuntimeConfig store (or
// its ABSENCE) into the clean `RuntimeConfig` shape the connector-registry tool-list
// gating + the agent loop consume.
//
// THE LOAD-BEARING DEFAULT: a MISSING row (no config) ⇒ "all connectors enabled, breadth
// on, MCP off" — EXACTLY today's behavior. So existing orgs are unaffected until an admin
// opts in. `enabledConnectors: null` is the canonical "all enabled" sentinel; an explicit
// array opts into a subset (and an empty array means NONE enabled).
//
// The DB models the tri-state as `allowlistEnabled` (a flag) + `enabledConnectors` (the
// subset) because Prisma has no nullable scalar list; this loader collapses that back to
// the clean `string[] | null` the rest of the system reads.

import { prisma } from "@/lib/db/client";

/**
 * The normalized per-org runtime config. This is the shape the tool-list gating + the
 * agent loop consume — NOT the raw Prisma row.
 */
export interface RuntimeConfig {
  /**
   * The connector ALLOWLIST by provider id, or `null` for "all registered connectors
   * enabled" (the default). An explicit array opts into a SUBSET; an empty array enables
   * NONE. `null` (not `[]`) is the default — preserving current behavior.
   */
  enabledConnectors: string[] | null;
  /** The Nango/commercial-breadth toggle. Default true; forced false for GOV by guardrails. */
  breadthEnabled: boolean;
  /** External-MCP exposure. Default false; forced false for GOV by guardrails. */
  mcpEnabled: boolean;
}

/** The default config a MISSING row resolves to — current behavior, fail-open for breadth
 *  (commercial default) but the gov-block + egress gate still apply on top. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  enabledConnectors: null,
  breadthEnabled: true,
  mcpEnabled: false,
};

/**
 * Load (and normalize) an org's runtime config. A missing row ⇒ {@link DEFAULT_RUNTIME_CONFIG}
 * (all enabled / breadth on / mcp off) — so an org that never opted in keeps today's behavior.
 */
export async function getRuntimeConfig(orgId: string): Promise<RuntimeConfig> {
  const row = await prisma.orgRuntimeConfig.findUnique({ where: { orgId } });
  if (!row) return { ...DEFAULT_RUNTIME_CONFIG };
  return normalizeRuntimeConfig(row);
}

/**
 * Collapse a raw OrgRuntimeConfig row into the clean RuntimeConfig shape: the
 * `allowlistEnabled` flag + `enabledConnectors` array become `string[] | null`
 * (false ⇒ null ⇒ "all enabled"; true ⇒ the explicit subset).
 */
export function normalizeRuntimeConfig(row: {
  allowlistEnabled: boolean;
  enabledConnectors: string[];
  breadthEnabled: boolean;
  mcpEnabled: boolean;
}): RuntimeConfig {
  return {
    enabledConnectors: row.allowlistEnabled ? row.enabledConnectors : null,
    breadthEnabled: row.breadthEnabled,
    mcpEnabled: row.mcpEnabled,
  };
}
