// src/lib/ai/egress/provider.ts
import Anthropic from "@anthropic-ai/sdk";
import type { ModelCredential } from "./types";

export type { ModelCredential } from "./types";

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

// ModelCredential is defined in ./types (the dependency-free module) and
// re-exported above so existing `from "./provider"` imports keep working while
// `@/lib/ai/ai-credentials` can reference the type without importing this
// model-calling provider (which the single-path arch test forbids).

export interface CallModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  model: string;
  maxTokens?: number;
  /** When provided, stream text deltas to the caller (final result still returned). */
  onTextDelta?: (delta: string) => void;
  /** Per-call credential resolved by the egress layer. Omit ⇒ env ANTHROPIC_API_KEY. */
  credential?: ModelCredential;
}

// Claude subscription (OAuth) tokens are authorized only for Claude Code; the API
// requires the system to lead with this identity block or it 401/403s the call.
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA = "oauth-2025-04-20";

// Short aliases (sonnet/opus/haiku) are a Claude Code CLI convenience — the raw
// Messages API rejects them with 404 not_found. Normalize to full model IDs here
// (the single egress point) so every caller works regardless of credential path.
// A value that's already a full id passes through unchanged.
const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-1",
  haiku: "claude-haiku-4-5-20251001",
};
function resolveModel(model: string): string {
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

let _envClient: Anthropic | null = null;

/** Build the SDK client for the resolved credential (env key cached; others per-call). */
function clientFor(credential: ModelCredential | undefined): Anthropic {
  if (!credential) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error(
        "No model credential: ANTHROPIC_API_KEY is unset and no org Claude subscription is connected.",
      );
    if (_envClient) return _envClient;
    _envClient = new Anthropic({ apiKey });
    return _envClient;
  }
  if (credential.kind === "oauth") {
    // apiKey:null is REQUIRED — without it the SDK auto-reads ANTHROPIC_API_KEY
    // from env and sends BOTH x-api-key AND Authorization:Bearer, so Anthropic
    // 401s on the (stale) x-api-key. null ⇒ Bearer only (and the SDK only injects
    // the oauth beta header when apiKey is null).
    return new Anthropic({
      apiKey: null,
      authToken: credential.token,
      defaultHeaders: { "anthropic-beta": OAUTH_BETA },
    });
  }
  // Likewise pin apiKey explicitly so an env var can't shadow the resolved key.
  return new Anthropic({ apiKey: credential.apiKey, authToken: null });
}

/**
 * System payload for the call. A subscription (oauth) token must lead with the
 * Claude Code identity as a SEPARATE system block (the real instructions follow
 * in a second block, so agent behavior is preserved). API-key calls send the
 * system string unchanged.
 */
function buildSystem(
  system: string,
  credential: ModelCredential | undefined,
): Anthropic.MessageCreateParams["system"] {
  if (credential?.kind === "oauth") {
    return [
      { type: "text", text: CLAUDE_CODE_IDENTITY },
      { type: "text", text: system },
    ];
  }
  return system;
}

/* -------------------------------------------------------------------------- */
/*  OpenAI-compatible path (raw Chat Completions over fetch — no SDK)          */
/* -------------------------------------------------------------------------- */

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Coerce a tool_result/text block's content to a string for OpenAI. */
function blockContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string"
          ? (b as { text: string }).text
          : typeof b === "string"
            ? b
            : JSON.stringify(b),
      )
      .join("");
  }
  return typeof content === "undefined" || content === null ? "" : JSON.stringify(content);
}

/**
 * Translate the Anthropic `messages` (content may be a string OR an array of
 * {type:"text"|"tool_use"|"tool_result"} blocks) into OpenAI Chat Completions
 * messages. A leading `system` string becomes a prepended {role:"system"} message.
 */
function toOpenAiMessages(system: string, messages: ModelMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (typeof m.content === "string") {
      // OpenAI has no top-level "tool" role for string user/assistant bodies.
      out.push({ role: m.role, content: m.content } as OpenAiMessage);
      continue;
    }
    // Block array — split into text, tool_use (assistant tool_calls), tool_result (tool role).
    const blocks = m.content as unknown as Array<Record<string, unknown>>;
    if (m.role === "assistant") {
      let text = "";
      const toolCalls: OpenAiToolCall[] = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") {
          text += b.text;
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: String(b.id ?? ""),
            type: "function",
            function: {
              name: String(b.name ?? ""),
              arguments: JSON.stringify(b.input ?? {}),
            },
          });
        }
      }
      out.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user-role array: tool_result blocks → {role:"tool"}, text blocks → {role:"user"}.
      let userText = "";
      for (const b of blocks) {
        if (b.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id ?? ""),
            content: blockContentToString(b.content),
          });
        } else if (b.type === "text" && typeof b.text === "string") {
          userText += b.text;
        }
      }
      if (userText.length > 0) out.push({ role: "user", content: userText });
    }
  }
  return out;
}

/** Translate Anthropic tool defs → OpenAI tools. */
function toOpenAiTools(tools: ModelTool[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** OpenAI finish_reason → an Anthropic-style stopReason (best effort, for the result shape). */
function mapFinishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return reason ?? null;
  }
}

/**
 * Call an OpenAI-COMPATIBLE Chat Completions endpoint. Streams when `onTextDelta`
 * is set (parses SSE `data:` lines). Returns the SAME {@link ModelTurnResult} shape
 * as the Anthropic path so the agent loop is provider-agnostic. Throws on non-2xx
 * with the status + a body snippet (the caller's error handling maps it).
 */
async function callOpenAi(
  req: CallModelRequest,
  credential: { kind: "openai"; baseURL: string; apiKey: string; model: string },
): Promise<ModelTurnResult> {
  const url = `${credential.baseURL.replace(/\/$/, "")}/chat/completions`;
  const stream = Boolean(req.onTextDelta);
  const body = {
    model: credential.model,
    max_tokens: req.maxTokens ?? 4096,
    messages: toOpenAiMessages(req.system, req.messages),
    ...(req.tools.length > 0 ? { tools: toOpenAiTools(req.tools) } : {}),
    ...(stream ? { stream: true } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenAI-compatible request failed (${res.status}): ${errText.slice(0, 300)}`,
    );
  }

  if (stream && res.body) {
    return readOpenAiStream(res.body, req.onTextDelta);
  }

  const json = (await res.json()) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        tool_calls?: OpenAiToolCall[];
      };
    }>;
  };
  const choice = json.choices?.[0];
  const text = choice?.message?.content ?? "";
  const toolUses = parseOpenAiToolCalls(choice?.message?.tool_calls);
  return { text: text ?? "", toolUses, stopReason: mapFinishReason(choice?.finish_reason) };
}

/** Parse OpenAI tool_calls into ModelToolUse (JSON.parse the arguments string). */
function parseOpenAiToolCalls(toolCalls: OpenAiToolCall[] | undefined): ModelToolUse[] {
  if (!toolCalls?.length) return [];
  return toolCalls.map((tc) => {
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(tc.function.arguments || "{}");
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      input = {};
    }
    return { id: tc.id, name: tc.function.name, input };
  });
}

/**
 * Parse the OpenAI streaming SSE response, emitting content deltas to onTextDelta
 * and accumulating text + tool_calls (which arrive incrementally by index).
 */
async function readOpenAiStream(
  stream: ReadableStream<Uint8Array>,
  onTextDelta: ((delta: string) => void) | undefined,
): Promise<ModelTurnResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason: string | null = null;
  // tool_calls stream incrementally, keyed by index; arguments arrive as fragments.
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let evt: {
        choices?: Array<{
          finish_reason?: string | null;
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        evt = JSON.parse(data);
      } catch {
        continue; // skip malformed SSE fragments
      }
      const choice = evt.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        try {
          onTextDelta?.(delta.content);
        } catch {
          /* never let a UI callback break the turn */
        }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolAcc.set(idx, acc);
        }
      }
    }
  }

  const toolUses: ModelToolUse[] = [...toolAcc.values()].map((a) => {
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(a.args || "{}");
      if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
    } catch {
      input = {};
    }
    return { id: a.id, name: a.name, input };
  });

  return { text, toolUses, stopReason: mapFinishReason(finishReason) };
}

/**
 * The ONLY function in the codebase that talks to the commercial model.
 * STATELESS per call: one request/response, no resident process, no session id,
 * no upstream conversation cache — so a value withheld on a later turn can never
 * have been retained from an earlier one. Reachable only via `egress/` (arch test).
 */
export async function callModel(req: CallModelRequest): Promise<ModelTurnResult> {
  // OpenAI-compatible path: raw Chat Completions over fetch (NOT the Anthropic SDK).
  if (req.credential?.kind === "openai") {
    return callOpenAi(req, req.credential);
  }

  const c = clientFor(req.credential);
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: resolveModel(req.model),
    max_tokens: req.maxTokens ?? 4096,
    system: buildSystem(req.system, req.credential),
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
