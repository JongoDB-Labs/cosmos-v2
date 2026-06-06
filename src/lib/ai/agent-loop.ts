import { cosmosTools, type ToolDefinition } from "./tools";
import { executeTool } from "./tool-executor";
import { runModelTurn, toModelTools, projectForModel, type ModelMessage } from "./egress";
import type { TenantClass } from "./egress";

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
 * model context: `commercial` passes through; `gov` is fail-closed (Phase 0 has
 * no live gov model path).
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
  /** Drives the egress gate. Phase 0: gov is fail-closed (no model path yet). */
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
  const tools = toModelTools(opts.tools ?? cosmosTools);
  const max = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  const model = opts.model ?? DEFAULT_MODEL;
  const messages: ModelMessage[] = [{ role: "user", content: opts.initialPrompt }];
  const toolCalls: AgentToolCall[] = [];
  let finalText = "";

  for (let turn = 0; turn < max; turn++) {
    const ctx = { conversationId: opts.conversationId, turn, tenantClass: opts.tenantClass, mode: "passthrough" as const };
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
    for (const u of reply.toolUses) {
      const output = await executeTool(u.name, u.input, { orgId: opts.orgId, userId: opts.userId });
      const projected = projectForModel(output, ctx, { valueKind: "tool_result", toolName: u.name });
      toolResultBlocks.push({
        type: "tool_result" as const,
        tool_use_id: u.id,
        content: JSON.stringify(projected.modelValue),
      });
      toolCalls.push({ id: u.id, name: u.name, arguments: u.input, result: output });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  if (!finalText) {
    finalText = "I couldn't finish that within the tool-call budget — please narrow the request.";
  }
  return { text: finalText, toolCalls };
}
