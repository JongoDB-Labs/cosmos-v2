// src/lib/ai/policy/enforce.ts
//
// `checkAgentPolicy` — the PURE 3-axis decision function for the AgentPolicy middle gate
// (design D9/§8). The agent loop calls this for EVERY tool BEFORE executeTool (after
// handle-resolve, before the write-path taint check). It NEVER touches the DB, the model, or
// CUI — it's a pure function of (policy, toolName, args) so it's exhaustively unit-testable.
//
// The 3 axes, evaluated in order (first DENY wins; CLAMP only applies if nothing denied):
//   1. TOOLS  — `deniedTools` contains the tool ⇒ DENY. Else `allowedTools` is set (non-null)
//               and the tool isn't in it ⇒ DENY. (denylist beats allowlist.)
//   2. DOMAIN — domainForTool(name) ∈ `deniedDomains` ⇒ DENY.
//   3. ARGS   — (a) a `projectId` arg present and NOT in `allowedProjectIds` (when set) ⇒ DENY.
//               (b) a `limit`/`maxResults` arg > `maxResultLimit` (when set) ⇒ CLAMP it down.
//
// DENY ⇒ the loop does NOT execute the tool, hands the model a block error (axis + reason,
// never CUI), and audits decidedBy:"agentpolicy". CLAMP ⇒ the loop executes with the clamped
// args (the executor receives the reduced limit) — a non-blocking adjustment.
//
// PERMISSIVE DEFAULT: against PERMISSIVE_AGENT_POLICY (allowedTools/allowedProjectIds null,
// empty deny lists, null maxResultLimit) EVERY branch is a no-op ⇒ { action: "allow" }. So a
// no-policy org runs every tool unchanged.

import type { AgentPolicy } from "./index";
import { domainForTool } from "./domains";

export type AgentPolicyAction = "allow" | "deny" | "clamp";

export interface AgentPolicyDecision {
  action: AgentPolicyAction;
  /** Which axis fired + why — SAFE to surface to the model (names tool/domain/arg, never CUI). */
  reason?: string;
  /** Present only when action==="clamp": the args to execute WITH (the original, limit reduced). */
  clampedArgs?: Record<string, unknown>;
}

/** The arg keys the maxResultLimit clamp applies to (a tool may use either spelling). */
const LIMIT_ARG_KEYS = ["limit", "maxResults"] as const;

/**
 * Decide whether `toolName` (with `args`) may run under `policy`. Pure: no I/O, no mutation of
 * `args` (a clamp returns a fresh `clampedArgs` object). See the file header for the contract.
 */
export function checkAgentPolicy(
  policy: AgentPolicy,
  toolName: string,
  args: Record<string, unknown>,
): AgentPolicyDecision {
  // ── AXIS 1: TOOLS ───────────────────────────────────────────────────────────
  // Denylist wins. Then an allowlist (when set) excludes anything not in it.
  if (policy.deniedTools.includes(toolName)) {
    return { action: "deny", reason: `tool "${toolName}" is denied by agent policy (tools axis)` };
  }
  if (policy.allowedTools !== null && !policy.allowedTools.includes(toolName)) {
    return { action: "deny", reason: `tool "${toolName}" is not in the agent policy allowlist (tools axis)` };
  }

  // ── AXIS 2: DOMAIN ──────────────────────────────────────────────────────────
  const domain = domainForTool(toolName);
  if (policy.deniedDomains.includes(domain)) {
    return { action: "deny", reason: `data domain "${domain}" is denied by agent policy (domain axis)` };
  }

  // ── AXIS 3a: ARG — project scope (DENY) ───────────────────────────────────────
  // Only enforce when the allowlist is set AND the call actually carries a string projectId.
  if (policy.allowedProjectIds !== null) {
    const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
    if (projectId !== undefined && !policy.allowedProjectIds.includes(projectId)) {
      return {
        action: "deny",
        reason: `project scope is not in the agent policy allowlist (arg axis: projectId)`,
      };
    }
  }

  // ── AXIS 3b: ARG — result-limit cap (CLAMP, not deny) ─────────────────────────
  // A `limit`/`maxResults` arg above maxResultLimit is reduced to the cap; the tool still runs.
  if (policy.maxResultLimit !== null) {
    let clamped: Record<string, unknown> | undefined;
    for (const key of LIMIT_ARG_KEYS) {
      const v = args[key];
      if (typeof v === "number" && Number.isFinite(v) && v > policy.maxResultLimit) {
        clamped ??= { ...args };
        clamped[key] = policy.maxResultLimit;
      }
    }
    if (clamped) {
      return {
        action: "clamp",
        reason: `result limit clamped to ${policy.maxResultLimit} by agent policy (arg axis: limit)`,
        clampedArgs: clamped,
      };
    }
  }

  return { action: "allow" };
}
