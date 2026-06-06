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
  /** The full native conversation (tool_result blocks are projected by the loop BEFORE landing here). */
  messages: ModelMessage[];
  tools: ModelTool[];
  model: string;
  maxTokens?: number;
  onTextDelta?: (delta: string) => void;
}

/**
 * The single chokepoint to the model. Projects the system prompt + the latest
 * user content through the gate (logging an EgressDecision for each), then calls
 * the provider. The agent loop must call THIS — never `provider.callModel`
 * directly (enforced by ESLint + the single-path arch test).
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
    messages: input.messages,
    tools: input.tools,
    model: input.model,
    maxTokens: input.maxTokens,
    onTextDelta: input.onTextDelta,
  };
  return callModel(req);
}
