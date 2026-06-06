import { cosmosTools } from "./tools";
import { executeTool, type ParsedToolCall } from "./tool-executor";
import { callClaudeCli, callClaudeCliStreaming } from "./claude-cli";

/**
 * Shared blocking tool-use loop — the reusable core of the assistant's
 * `runBlocking` path (assistant/conversations/[id]/messages/route.ts). Both the
 * AI assistant and the in-channel chat bots run on this so chat AI gains the
 * same ~31 cosmos tools + per-org MCP the assistant already has.
 *
 * SECURITY: every tool runs via `executeTool(..., { orgId, userId })`, which
 * each tool permission-checks against THAT user — so a bot can never do
 * anything the invoking user couldn't. Callers pass the invoker's id.
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

function followupPrompt(
  prior: string,
  assistantText: string,
  results: { call: ParsedToolCall; output: unknown }[],
): string {
  const block = results
    .map((r) => `Tool ${r.call.name} returned: ${JSON.stringify(r.output)}`)
    .join("\n\n");
  return `${prior}\n\nAssistant: ${assistantText}\n\n[Tool results — use these to compose your reply. Issue more TOOL_CALL lines only if you genuinely need additional data.]\n${block}\n\nAssistant:`;
}

export interface RunAgentLoopOptions {
  orgId: string;
  /** The INVOKING user — tools execute as this identity (perm-scoped). */
  userId: string;
  systemPrompt: string;
  initialPrompt: string;
  model?: string;
  mcpConfigPath?: string | null;
  tools?: typeof cosmosTools;
  maxIterations?: number;
  /**
   * When provided, the loop streams the FINAL user-facing answer (the
   * no-more-tool-calls response) via `callClaudeCliStreaming`, invoking this
   * callback with the running answer text as it grows. Intermediate
   * tool-deciding turns are NOT streamed to the user — only the final reply,
   * matching what the return value's `text` ends up being. Tool execution and
   * the MAX_TOOL_ITERATIONS budget are identical to the non-streaming path.
   */
  onDelta?: (textSoFar: string) => void;
}

export async function runAgentLoop(
  opts: RunAgentLoopOptions,
): Promise<AgentLoopResult> {
  const tools = opts.tools ?? cosmosTools;
  const max = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  let prompt = opts.initialPrompt;
  const toolCalls: AgentToolCall[] = [];
  let finalText = "";
  let iterations = 0;

  while (iterations < max) {
    let reply: { content: string; toolCalls: ParsedToolCall[] };
    if (opts.onDelta) {
      // Stream this turn. If it produces tool calls (i.e. it was NOT the final
      // answer) the partial text streamed here is the model's prose BEFORE the
      // TOOL_CALL marker — typically empty or a short "let me check…". We
      // forward deltas for the FINAL turn only by resetting the running buffer
      // each turn and ignoring buffers that end up belonging to a tool turn:
      // the bot-runner overwrites the placeholder with the latest buffer, and
      // because the final turn streams last, the user ends on the real answer.
      let turnText = "";
      reply = await callClaudeCliStreaming(opts.systemPrompt, prompt, tools, {
        model: opts.model,
        mcpConfigPath: opts.mcpConfigPath ?? undefined,
        onTextDelta: (delta) => {
          turnText += delta;
          // Don't stream past a TOOL_CALL marker — once the model starts
          // emitting a tool directive, the visible prose for this turn is
          // done; the rest is machine syntax the user shouldn't see.
          const cut = turnText.indexOf("TOOL_CALL:");
          const visible = cut === -1 ? turnText : turnText.slice(0, cut);
          opts.onDelta?.(visible.trimEnd());
        },
      });
    } else {
      reply = await callClaudeCli(opts.systemPrompt, prompt, tools, {
        model: opts.model,
        mcpConfigPath: opts.mcpConfigPath ?? undefined,
      });
    }
    if (reply.toolCalls.length === 0) {
      finalText = reply.content;
      break;
    }
    const results: { call: ParsedToolCall; output: unknown }[] = [];
    for (const call of reply.toolCalls) {
      const output = await executeTool(call.name, call.arguments, {
        orgId: opts.orgId,
        userId: opts.userId,
      });
      results.push({ call, output });
      toolCalls.push({
        id: `tc_${toolCalls.length + 1}_${Date.now()}`,
        name: call.name,
        arguments: call.arguments,
        result: output,
      });
    }
    prompt = followupPrompt(prompt, reply.content, results);
    iterations++;
  }

  if (!finalText) {
    finalText =
      "I couldn't finish that within the tool-call budget — please narrow the request.";
  }
  return { text: finalText, toolCalls };
}
