// src/lib/ai/egress/provider.ts
import Anthropic from "@anthropic-ai/sdk";

export type ModelMessage = Anthropic.MessageParam;

export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelTurnResult {
  text: string;
  toolUses: ModelToolUse[];
  stopReason: string | null;
}

export interface CallModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  model: string;
  maxTokens?: number;
  /** When provided, stream text deltas to the caller (final result still returned). */
  onTextDelta?: (delta: string) => void;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — the egress provider cannot reach the model");
  if (_client) return _client;
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * The ONLY function in the codebase that talks to the commercial model.
 * STATELESS per call: one request/response, no resident process, no session id,
 * no upstream conversation cache — so a value withheld on a later turn can never
 * have been retained from an earlier one. Reachable only via `egress/` (arch test).
 */
export async function callModel(req: CallModelRequest): Promise<ModelTurnResult> {
  const c = client();
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    system: req.system,
    messages: req.messages,
    tools: req.tools as unknown as Anthropic.Tool[],
  };

  let final: Anthropic.Message;
  if (req.onTextDelta) {
    const stream = c.messages.stream(params);
    stream.on("text", (delta: string) => {
      try {
        req.onTextDelta?.(delta);
      } catch {
        /* never let a UI callback break the turn */
      }
    });
    final = await stream.finalMessage();
  } else {
    final = await c.messages.create(params);
  }

  let text = "";
  const toolUses: ModelToolUse[] = [];
  for (const block of final.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolUses.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
    }
  }
  return { text, toolUses, stopReason: final.stop_reason };
}
