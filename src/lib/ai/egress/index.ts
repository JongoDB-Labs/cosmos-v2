// src/lib/ai/egress/index.ts
import { callModel, type CallModelRequest, type ModelMessage, type ModelTool, type ModelTurnResult } from "./provider";
import { projectForModel } from "./gate";
import { logEgressDecision } from "./audit";
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
 * Phase 0 scope: it projects the SYSTEM prompt through the gate (withheld for
 * gov) and logs an EgressDecision for the system prompt and the latest user
 * message. It does NOT yet project the full `messages` array — message bodies
 * are forwarded as-is. This is safe in Phase 0 because (a) gov has no live model
 * path (the loop fails closed / gov isn't wired) and (b) the loop projects
 * tool_result bodies upstream. It is NOT yet fail-closed on conversation bodies.
 *
 * TODO(phase-1): project EVERY entry of `input.messages` through the gate here
 * (per-message classification + opaque handles), so a gov tenant's conversation
 * body can never reach the model regardless of caller discipline. Until then,
 * do not route gov traffic through this function.
 */
export async function runModelTurn(input: RunModelTurnInput): Promise<ModelTurnResult> {
  const sys = projectForModel(input.system, input.ctx, { valueKind: "system" });
  logEgressDecision(sys.decision);

  const last = input.messages[input.messages.length - 1];
  if (last && typeof last.content === "string") {
    const proj = projectForModel(last.content, input.ctx, { valueKind: "user" });
    logEgressDecision(proj.decision);
  }

  const req: CallModelRequest = {
    system: typeof sys.modelValue === "string" ? sys.modelValue : "[withheld]",
    // TODO(phase-1): forward PROJECTED messages, not the raw array (see above).
    messages: input.messages,
    tools: input.tools,
    model: input.model,
    maxTokens: input.maxTokens,
    onTextDelta: input.onTextDelta,
  };
  return callModel(req);
}
