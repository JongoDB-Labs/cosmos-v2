import { spawn } from "node:child_process";
import {
  type ParsedToolCall,
  parseToolCalls,
} from "./tool-executor";
import {
  type ToolDefinition,
  formatToolsForSystemPrompt,
} from "./tools";

export interface CallClaudeCliOptions {
  /** Model alias passed to `--model`. Defaults to "sonnet". */
  model?: string;
  /** Hard subprocess timeout in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Override the binary name (mainly for tests). */
  binary?: string;
  /** Called for every text token the model emits before the TOOL_CALL marker. */
  onTextDelta?: (delta: string) => void;
  /**
   * Path to an MCP config JSON (see `lib/ai/mcp-config.ts`). When provided,
   * the CLI is launched with `--mcp-config <path>` so the model can call
   * tools from any servers listed in the file. Cleanup of the temp file is
   * the caller's responsibility.
   */
  mcpConfigPath?: string;
}

export interface CallClaudeCliResult {
  /** Plain prose returned before the first TOOL_CALL marker (or the entire reply if no calls). */
  content: string;
  /** Structured tool invocations extracted from the model's text. */
  toolCalls: ParsedToolCall[];
}

const TOOL_INSTRUCTION =
  'To call a tool, include EXACTLY this on its own line:\nTOOL_CALL: {"name": "tool_name", "arguments": {...}}\n\nIf you do NOT need a tool, respond normally.';

/**
 * Build the full system prompt that gets handed to `claude -p` via
 * `--system-prompt`. Tool descriptions are concatenated underneath the base
 * prompt, followed by the TOOL_CALL contract.
 */
export function buildSystemPrompt(
  baseSystemPrompt: string,
  tools: ToolDefinition[]
): string {
  const toolBlock = formatToolsForSystemPrompt(tools);
  if (!toolBlock) return `${baseSystemPrompt}\n\n${TOOL_INSTRUCTION}`;
  return `${baseSystemPrompt}\n\nAVAILABLE TOOLS:\n${toolBlock}\n\n${TOOL_INSTRUCTION}`;
}

/**
 * Spawn the local `claude` CLI in one-shot mode and return the model's
 * reply. The CLI handles its own upstream auth (via the user's
 * `claude setup-token` credentials in `~/.claude.json`), so there is no
 * Anthropic API key in this path. The text is then scanned for our custom
 * `TOOL_CALL: {...}` directives.
 *
 * Reference: /home/defcon/okr-dashboard/server/index.js:6265 `callClaudeCli`.
 */
export function callClaudeCli(
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDefinition[],
  opts: CallClaudeCliOptions = {}
): Promise<CallClaudeCliResult> {
  const {
    model = "sonnet",
    timeoutMs = 300_000,
    binary = "claude",
    mcpConfigPath,
  } = opts;

  const fullSystemPrompt = buildSystemPrompt(systemPrompt, tools);

  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--model",
      model,
      "--no-session-persistence",
      "--system-prompt",
      fullSystemPrompt,
    ];
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    // Inherit env but strip Claude Code's nested-invocation markers. If we
    // leave them set, the spawned `claude` will think it's being launched
    // from inside another Claude Code session and may refuse to act.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(binary, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`claude CLI spawn error: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // `--output-format json` wraps the reply as `{ result: "...", ... }`.
      // Fall back to raw stdout if it isn't valid JSON.
      let body = "";
      try {
        const parsed = JSON.parse(stdout.trim()) as {
          result?: unknown;
          content?: unknown;
        };
        if (typeof parsed.result === "string") body = parsed.result;
        else if (typeof parsed.content === "string") body = parsed.content;
        else body = stdout.trim();
      } catch {
        body = stdout.trim();
      }

      if (code !== 0 && !body) {
        const tail = stderr.slice(-500);
        return reject(
          new Error(
            `claude CLI exited with code ${code ?? "null"}${
              tail ? `: ${tail}` : ""
            }`
          )
        );
      }
      if (!body) {
        return reject(new Error("claude CLI returned empty response"));
      }

      const { toolCalls, firstMatchIndex } = parseToolCalls(body);
      if (toolCalls.length > 0) {
        const prose = body.slice(0, firstMatchIndex).trim();
        resolve({ content: prose, toolCalls });
      } else {
        resolve({ content: body.trim(), toolCalls: [] });
      }
    });

    try {
      proc.stdin.write(userPrompt);
      proc.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          `failed to write to claude CLI stdin: ${(err as Error).message}`
        )
      );
    }
  });
}

/**
 * Streaming variant — spawns the CLI with `--output-format stream-json
 * --include-partial-messages` so we can forward text deltas to the caller
 * (typically an SSE handler) as the model produces them. Returns the final
 * parsed result once the subprocess exits, identical in shape to
 * `callClaudeCli`.
 *
 * Tool-call detection happens AFTER streaming finishes — we scan the full
 * accumulated text for TOOL_CALL markers. If found, the iteration loop
 * runs the tools and calls this function again for the next iteration.
 */
export function callClaudeCliStreaming(
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDefinition[],
  opts: CallClaudeCliOptions = {},
): Promise<CallClaudeCliResult> {
  const {
    model = "sonnet",
    timeoutMs = 300_000,
    binary = "claude",
    onTextDelta,
    mcpConfigPath,
  } = opts;

  const fullSystemPrompt = buildSystemPrompt(systemPrompt, tools);

  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--tools",
      "",
      "--model",
      model,
      "--no-session-persistence",
      "--system-prompt",
      fullSystemPrompt,
    ];
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(binary, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";
    let accumulatedText = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function handleEventLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }

      // The Claude CLI's stream-json format emits multiple event types.
      // We look for text_delta payloads inside stream_event events, and
      // also fall back to "assistant" events with content[].text for
      // robustness across CLI versions.
      const type = evt.type as string | undefined;

      if (type === "stream_event") {
        const eventObj = evt.event as Record<string, unknown> | undefined;
        if (eventObj?.type === "content_block_delta") {
          const delta = eventObj.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            accumulatedText += delta.text;
            try {
              onTextDelta?.(delta.text);
            } catch {
              /* swallow callback errors */
            }
          }
        }
      } else if (type === "assistant") {
        // Some CLI versions emit a complete assistant message in one
        // event. Pull text from content[].
        const msg = evt.message as { content?: Array<Record<string, unknown>> } | undefined;
        const blocks = msg?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === "text" && typeof b.text === "string") {
              const delta = (b.text as string).slice(accumulatedText.length);
              if (delta) {
                accumulatedText += delta;
                try {
                  onTextDelta?.(delta);
                } catch {
                  /* swallow */
                }
              }
            }
          }
        }
      } else if (type === "result") {
        // Final wrapped result. If we somehow didn't see any deltas, use
        // this as the source of truth.
        const resultText = evt.result as string | undefined;
        if (resultText && resultText.length > accumulatedText.length) {
          const delta = resultText.slice(accumulatedText.length);
          accumulatedText += delta;
          try {
            onTextDelta?.(delta);
          } catch {
            /* swallow */
          }
        }
      }
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      // Process complete lines, keep partial line in buffer.
      let nl = stdoutBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        handleEventLine(line);
        nl = stdoutBuffer.indexOf("\n");
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`claude CLI spawn error: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Flush any trailing partial line.
      if (stdoutBuffer.trim()) handleEventLine(stdoutBuffer);

      if (code !== 0 && !accumulatedText) {
        const tail = stderr.slice(-500);
        return reject(
          new Error(
            `claude CLI exited with code ${code ?? "null"}${tail ? `: ${tail}` : ""}`,
          ),
        );
      }
      if (!accumulatedText) {
        return reject(new Error("claude CLI returned empty response"));
      }

      const { toolCalls, firstMatchIndex } = parseToolCalls(accumulatedText);
      if (toolCalls.length > 0) {
        const prose = accumulatedText.slice(0, firstMatchIndex).trim();
        resolve({ content: prose, toolCalls });
      } else {
        resolve({ content: accumulatedText.trim(), toolCalls: [] });
      }
    });

    try {
      proc.stdin.write(userPrompt);
      proc.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          `failed to write to claude CLI stdin: ${(err as Error).message}`,
        ),
      );
    }
  });
}
