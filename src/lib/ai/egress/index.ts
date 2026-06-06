// src/lib/ai/egress/index.ts
import { callModel, type CallModelRequest, type ModelMessage, type ModelTool, type ModelTurnResult } from "./provider";
import { projectForModel } from "./gate";
import { logEgressDecision } from "./audit";
import { effectiveCeiling } from "@/lib/classification/effective";
import type { EgressContext } from "./types";

export type { EgressContext, EgressDecision, TenantClass, ValueKind } from "./types";
export { isWithheld } from "./types";
export { projectForModel, sha256Hex } from "./gate";
export type { ModelMessage, ModelTool, ModelToolUse, ModelTurnResult } from "./provider";

/** v1 ToolDefinition already uses Anthropic's `input_schema` shape — map 1:1. */
export function toModelTools(tools: { name: string; description: string; input_schema: Record<string, unknown> }[]): ModelTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

export interface RunModelTurnInput {
  ctx: EgressContext;
  system: string;
  /**
   * The native conversation. The agent loop is responsible for projecting each
   * tool_result through the gate BEFORE appending it here (so tool_result bodies
   * are already model-safe). User/assistant message bodies are NOT yet projected
   * inside this function — see the Phase-1 TODO in runModelTurn.
   */
  messages: ModelMessage[];
  tools: ModelTool[];
  model: string;
  maxTokens?: number;
  onTextDelta?: (delta: string) => void;
}

/**
 * The single chokepoint to the model: the ONLY function that calls
 * `provider.callModel` (enforced by ESLint + the single-path arch test).
 *
 * Phase 1 scope: it resolves the org's effective ceiling, projects the SYSTEM
 * prompt + latest user message through the (now enforced) gate, and logs an
 * EgressDecision for each. The agent loop projects every tool_result body
 * upstream under the data-driven MAC ceiling before it re-enters `messages`, so
 * data egress is fail-closed. It does NOT yet project the full `messages` array
 * here — prior assistant/user message BODIES are forwarded as-is.
 *
 * TODO(phase-2): project EVERY entry of `input.messages` through the gate here
 * (per-message classification + opaque handles), so a gov tenant's conversation
 * body can never reach the model regardless of caller discipline. Until then, a
 * gov tenant's tool-result DATA is withheld, but its system prompt + conversation
 * BODY DO still reach the commercial model (this function forwards input.messages
 * raw) — so do NOT route a gov tenant that may carry CUI in prompts through this
 * path until Phase 2 lands. There is no gov-blocking guard here yet.
 */
export async function runModelTurn(input: RunModelTurnInput): Promise<ModelTurnResult> {
  // Resolve the org's effective ceiling once. System/user are non-data (the gate
  // exposes them regardless of ceiling), but the decision record carries it as
  // audit evidence.
  const orgCeiling = await effectiveCeiling(input.ctx.orgId);

  const sys = projectForModel(input.system, input.ctx, { valueKind: "system", ceiling: orgCeiling });
  logEgressDecision(sys.decision);

  const last = input.messages[input.messages.length - 1];
  if (last && typeof last.content === "string") {
    const proj = projectForModel(last.content, input.ctx, { valueKind: "user", ceiling: orgCeiling });
    logEgressDecision(proj.decision);
  }

  const req: CallModelRequest = {
    system: typeof sys.modelValue === "string" ? sys.modelValue : "[withheld]",
    // TODO(phase-2): forward PROJECTED messages, not the raw array (see above).
    messages: input.messages,
    tools: input.tools,
    model: input.model,
    maxTokens: input.maxTokens,
    onTextDelta: input.onTextDelta,
  };
  return callModel(req);
}
