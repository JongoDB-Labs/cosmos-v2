import { cosmosTools, type ToolDefinition } from "./tools";
import { connectorToolDefs, connectorToolNames } from "./connectors";
import { executeTool } from "./tool-executor";
import { runModelTurn, toModelTools, projectForModel, projectResult, entityTypeForTool, augmentWithHandles, resolveHandlesDeep, sha256Hex, logEgressDecision, type ModelMessage } from "./egress";
import type { TenantClass } from "./egress";
import { effectiveCeiling, maxByRank, rankOf } from "@/lib/classification/effective";
import type { ClassificationLevel } from "@prisma/client";

/**
 * Opaque-handle resolver feature flag (default ON). When `EGRESS_HANDLES_ENABLED`
 * is explicitly "false"/"0"/"off", the loop behaves EXACTLY as before the resolver
 * shipped: withheld CUI fields are dropped (no tokens minted), and tool args are
 * not scanned for handles (a handle-shaped string, if any, passes through literally
 * — and resolves to nothing because none were minted). Any other value (incl.
 * unset) ⇒ ON. Read at call time so tests/deploys see the current env.
 */
function handlesEnabled(): boolean {
  const v = process.env.EGRESS_HANDLES_ENABLED?.toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "off";
}

/**
 * Unified agent loop — the ONE blocking/streaming tool-use loop behind both the
 * assistant route and the in-channel chat bots. It runs on native Anthropic
 * `tool_use` via `runModelTurn` (the single egress chokepoint); the old host
 * `claude` CLI / `TOOL_CALL:` text protocol and the per-org host-CLI MCP config
 * flag are gone.
 *
 * SECURITY: every tool runs via `executeTool(..., { orgId, userId })`, which
 * permission-checks against THAT user — so a bot can never do anything the
 * invoking user couldn't. Callers pass the invoker's id. Additionally, every
 * tool result is projected through the egress gate BEFORE it can re-enter the
 * model context under the data-driven MAC ceiling: CUI/FOUO data is withheld for
 * BOTH tenants; below that, `commercial` exposes and `gov` is default-deny.
 */

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface AgentLoopResult {
  text: string;
  toolCalls: AgentToolCall[];
}

const MAX_TOOL_ITERATIONS = 5;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export interface RunAgentLoopOptions {
  orgId: string;
  /** The INVOKING user — tools execute as this identity (perm-scoped). */
  userId: string;
  /** Drives the egress gate. CUI/FOUO data is withheld for both tenants; below that gov default-denies. */
  tenantClass: TenantClass;
  /** Conversation id for egress-decision audit correlation. */
  conversationId: string;
  systemPrompt: string;
  initialPrompt: string;
  model?: string;
  tools?: ToolDefinition[];
  maxIterations?: number;
  /** Stream the final answer's text deltas (final turn only). */
  onDelta?: (textSoFar: string) => void;
}

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<AgentLoopResult> {
  // ── D5 gov-block, LAYER 1 (the model never SEES a commercial-only tool) ────────
  // The base catalog (`cosmosTools`) has every connector tool baked in at module
  // load (the full, tenant-agnostic snapshot). Rebuild a TENANT-FILTERED list:
  // start from the base, drop ALL connector tools, then re-append exactly the
  // connector tools this tenant class may see (`connectorToolDefs(tenantClass)` —
  // which excludes commercial-only descriptors for gov). Native + "all"-availability
  // connectors (Google/GitHub) are unchanged for BOTH classes; only commercial-only
  // (Nango) tools are withheld from a gov tenant's model. A caller-supplied
  // `opts.tools` is treated the same way (filtered), so no surface bypasses L1.
  const allConnectorNames = connectorToolNames(); // full set (no class) — to subtract
  const baseTools = opts.tools ?? cosmosTools;
  const nativeAndForeign = baseTools.filter((t) => !allConnectorNames.has(t.name));
  const tenantTools: ToolDefinition[] = [
    ...nativeAndForeign,
    ...connectorToolDefs(opts.tenantClass),
  ];
  const tools = toModelTools(tenantTools);
  const max = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  const model = opts.model ?? DEFAULT_MODEL;
  const messages: ModelMessage[] = [{ role: "user", content: opts.initialPrompt }];
  const toolCalls: AgentToolCall[] = [];
  let finalText = "";

  for (let turn = 0; turn < max; turn++) {
    const ctx = { orgId: opts.orgId, conversationId: opts.conversationId, turn, tenantClass: opts.tenantClass, mode: "enforced" as const };
    let streamed = "";
    const reply = await runModelTurn({
      ctx,
      system: opts.systemPrompt,
      messages,
      tools,
      model,
      onTextDelta: opts.onDelta
        ? (delta) => { streamed += delta; opts.onDelta?.(streamed); }
        : undefined,
    });

    if (reply.toolUses.length === 0) {
      finalText = reply.text;
      break;
    }

    // Append the assistant's native tool_use blocks verbatim.
    messages.push({
      role: "assistant",
      content: [
        ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
        ...reply.toolUses.map((u) => ({ type: "tool_use" as const, id: u.id, name: u.name, input: u.input })),
      ],
    });

    // Run each tool as the invoking user; PROJECT each result through the gate
    // before it can re-enter the model context.
    const toolResultBlocks = [];
    const flagOn = handlesEnabled();
    for (const u of reply.toolUses) {
      // ── RESOLVE handles in the tool args BEFORE execution (in-boundary) ──
      // The model may carry an opaque handle (a token minted for a previously
      // withheld CUI field) into a later tool call. Resolve every whole-string,
      // conversation-scoped handle to its REAL value so the executor acts on the
      // CUI the model never read. resolveHandlesDeep is exact-match + bounded-depth;
      // a non-matching / wrong-conversation / fabricated handle passes through
      // literally (harmless). The RESOLVED value goes ONLY to the executor; its
      // result is re-gated below (no echo-back to the model).
      // The tool's TARGET project scope (if the tool was called with a string
      // projectId). Used both for the WRITE-PATH TAINT check below (where the data
      // would LAND) and for the per-result effective ceiling after execution.
      const projectId = typeof (u.input as { projectId?: unknown }).projectId === "string"
        ? (u.input as { projectId: string }).projectId : undefined;
      let execInput: Record<string, unknown> = u.input;
      let resolvedCount = 0;
      // C1: the HIGHEST mint-time ceiling among the handles resolved in THIS tool's
      // args. Folded into the result's effective gate ceiling below so a value
      // withheld under a high ceiling can never be resolved-and-echoed back under a
      // lower per-turn ceiling (e.g. a no-projectId turn re-gating at the org ceiling).
      let resolvedMaxCeiling: ClassificationLevel | null = null;
      if (flagOn) {
        const r = await resolveHandlesDeep(u.input, opts.conversationId);
        execInput = r.resolved as Record<string, unknown>;
        resolvedCount = r.count;
        resolvedMaxCeiling = r.maxCeiling;
        if (resolvedCount > 0) {
          // ── WRITE-PATH TAINT (fail-closed) ────────────────────────────────────
          // A value resolved from a handle minted at ceiling X may only be used in a
          // tool call whose TARGET context is classified ≥ X. `targetCeiling` is the
          // RAW effective ceiling of where the data would LAND (org ceiling when no
          // projectId) — NOT the v2.9.0-folded result ceiling. If the target is below
          // the resolved value's mint ceiling, executing this tool would PERSIST CUI
          // into a lower-classification container (down-classification laundering by
          // reference). REJECT before executeTool: the CUI is never written, never
          // logged, and never reaches the model (the error names only LEVELS).
          const targetCeiling = await effectiveCeiling(opts.orgId, projectId);
          if (resolvedMaxCeiling !== null && rankOf(targetCeiling) < rankOf(resolvedMaxCeiling)) {
            // AC-4 evidence: a down-classification write was PREVENTED. The hash is of
            // the ORIGINAL (handle) args — never the resolved CUI.
            logEgressDecision({
              conversationId: opts.conversationId, turn, valueKind: "tool_args",
              toolName: u.name, exposed: false, withheldCount: resolvedCount,
              contentHash: sha256Hex(JSON.stringify(u.input)), decidedBy: "handle_taint_block",
              tenantClass: opts.tenantClass, mode: "enforced", ceiling: resolvedMaxCeiling,
            });
            // Hand the model a structured taint-violation error (LEVELS only, no CUI)
            // so it sees the rejection and can retarget; do NOT execute the tool.
            const taintError = {
              error: `blocked: a value classified ${resolvedMaxCeiling} cannot be written into a context cleared only for ${targetCeiling} (would spill CUI into a lower-classification container). Use a project cleared for ${resolvedMaxCeiling}.`,
            };
            toolResultBlocks.push({
              type: "tool_result" as const,
              tool_use_id: u.id,
              content: JSON.stringify(taintError),
            });
            // Record the ORIGINAL (handle) args in the trail — never the resolved CUI,
            // consistent with the existing "userView/arguments → UI" rule. The result
            // is the levels-only error (no CUI), since nothing was executed.
            toolCalls.push({ id: u.id, name: u.name, arguments: u.input, result: taintError });
            continue;
          }
          // AC-4: record that N handles (CUI) moved by reference into an in-boundary
          // tool (allow path — target cleared ≥ resolved). The hash is of the ORIGINAL
          // (handle) args — never the resolved CUI.
          logEgressDecision({
            conversationId: opts.conversationId, turn, valueKind: "tool_args",
            toolName: u.name, exposed: false, withheldCount: resolvedCount,
            contentHash: sha256Hex(JSON.stringify(u.input)), decidedBy: "handle_resolve",
            tenantClass: opts.tenantClass, mode: "enforced",
          });
        }
      }
      // Thread the tenant class + conversation id so the connector dispatch layer
      // (L2) can hard-refuse a commercial-only tool for a gov tenant and AUDIT it.
      const output = await executeTool(u.name, execInput, {
        orgId: opts.orgId,
        userId: opts.userId,
        tenantClass: opts.tenantClass,
        conversationId: opts.conversationId,
      });
      // C1 FIX: fold the resolved handles' mint-time ceiling into the result's
      // effective gate ceiling (max-by-rank). Resolving a CUI-minted handle forces
      // this turn's result to be gated at ≥CUI ⇒ rank ≥ FOUO ⇒ WITHHELD for BOTH
      // tenants — so a high-ceiling value can never reach the model via a re-gate at
      // a lower per-turn ceiling, even on the otherwise-EXPOSED branch. Adds only a
      // FLOOR (never lowers the per-result ceiling); non-handle turns are unchanged.
      const ceiling = maxByRank(await effectiveCeiling(opts.orgId, projectId), resolvedMaxCeiling);
      const projected = projectForModel(output, ctx, { valueKind: "tool_result", toolName: u.name, ceiling });
      // On WITHHOLD, don't hand the model the opaque placeholder — give it a
      // STRUCTURAL projection (id + allowlisted enums/dates, never free-text/CUI)
      // so it can still orchestrate entities by id under the MAC ceiling.
      // `projectResult` unwraps executor wrappers ({count, items:[...]}) and is
      // itself default-deny (unknown entity / non-entity ⇒ full withhold).
      let modelView = projected.decision.exposed
        ? projected.modelValue                                        // exposed: full value
        : projectResult(output, entityTypeForTool(u.name));           // withheld: structural-only view
      // ── MINT handles on WITHHOLD (augment the structural view) ──
      // Only on the withheld path (exposed already gives the model the value, so
      // there is nothing to reference). For each HANDLEABLE_FIELDS CUI string field
      // present on a source entity, mint an opaque token and ADD it to the model
      // view (the structural fields stay). The model gets TOKENS, never the values
      // — and can later carry a token into a tool call (resolved above, in-boundary).
      if (flagOn && !projected.decision.exposed) {
        const entityType = entityTypeForTool(u.name);
        // Bind THIS result's (possibly handle-raised) ceiling to any handle minted on
        // the withheld structural view, so a downstream resolve of one of these tokens
        // re-gates at ≥ this ceiling too (C1 binding propagates transitively).
        const aug = await augmentWithHandles(modelView, output, entityType, opts.conversationId, ceiling);
        modelView = aug.modelView;
        if (aug.minted > 0) {
          // AC-4: record that N withheld CUI fields were minted as opaque handles.
          // The hash is of the WITHHELD structural model view (no CUI), not the source.
          logEgressDecision({
            conversationId: opts.conversationId, turn, valueKind: "tool_result",
            toolName: u.name, exposed: false, withheldCount: aug.minted,
            contentHash: sha256Hex(JSON.stringify(modelView)), decidedBy: "handle_mint",
            tenantClass: opts.tenantClass, mode: "enforced",
          });
        }
      }
      toolResultBlocks.push({
        type: "tool_result" as const,
        tool_use_id: u.id,
        content: JSON.stringify(modelView),
      });
      // userView (the full output) still flows only to the UI, never to the model.
      // Record the ORIGINAL (handle) args in the toolCalls trail — NOT the resolved
      // CUI: the resolved value is a withheld value the model fed back by reference,
      // so widening this UI/audit record to the resolved CUI would re-expose it to a
      // surface that only ever shows what the invoking user already sees. Keep it
      // consistent with the existing "userView/arguments → UI" rule.
      toolCalls.push({ id: u.id, name: u.name, arguments: u.input, result: output });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  if (!finalText) {
    finalText = "I couldn't finish that within the tool-call budget — please narrow the request.";
  }
  return { text: finalText, toolCalls };
}
