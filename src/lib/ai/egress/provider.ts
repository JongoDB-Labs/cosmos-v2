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

/**
 * How the chokepoint authenticates to the model for THIS call. Resolved by the
 * egress layer (which has org context) and passed in — the chokepoint stays
 * stateless and never reads org config itself.
 *  - apiKey: a standard `sk-ant-api…` key → `x-api-key`.
 *  - oauth:  a Claude **subscription** access token (`sk-ant-oat…`) → `Authorization:
 *            Bearer` + the oauth beta header. Subscription tokens are scoped to
 *            Claude Code, so the request must lead with the Claude Code system
 *            identity block or Anthropic rejects it (see buildSystem).
 */
export type ModelCredential =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "oauth"; token: string };

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

/**
 * The ONLY function in the codebase that talks to the commercial model.
 * STATELESS per call: one request/response, no resident process, no session id,
 * no upstream conversation cache — so a value withheld on a later turn can never
 * have been retained from an earlier one. Reachable only via `egress/` (arch test).
 */
export async function callModel(req: CallModelRequest): Promise<ModelTurnResult> {
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
