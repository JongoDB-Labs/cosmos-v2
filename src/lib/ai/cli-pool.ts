import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { parseToolCalls } from "./tool-executor";
import {
  type ToolDefinition,
} from "./tools";
import {
  type CallClaudeCliResult,
  buildSystemPrompt,
} from "./claude-cli";
import { cleanupMcpConfig } from "./mcp-config";

/**
 * Phase 2 — persistent CLI process pool.
 *
 * Each conversation gets one long-lived `claude -p --input-format stream-json
 * --output-format stream-json` subprocess. Cold-start (~2-3s) only hits the
 * first message; follow-ups send a JSON envelope on stdin and stream back
 * incrementally. Modeled after okr-dashboard's pool — see
 * /home/defcon/okr-dashboard/server/index.js around line 6038.
 *
 * Key invariants:
 *  - One in-flight message per conversation. Concurrent calls queue.
 *  - Process death (close/error) clears the pool entry; the next call spawns
 *    fresh.
 *  - Idle entries get reaped after IDLE_TTL_MS to bound process count.
 *  - Spawn failures bubble up — callers should fall back to one-shot mode.
 */

const IDLE_TTL_MS = 30 * 60 * 1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const PER_MESSAGE_TIMEOUT_MS = 15 * 60 * 1000;
const SPAWN_INIT_TIMEOUT_MS = 30 * 1000;

interface QueuedMessage {
  userText: string;
  onTextDelta?: (delta: string) => void;
  resolve: (value: CallClaudeCliResult) => void;
  reject: (err: Error) => void;
}

interface PoolEntry {
  proc: ChildProcessWithoutNullStreams;
  sessionId: string;
  /** Set true while a message is being processed (between send and result). */
  busy: boolean;
  /** Last successful send/receive timestamp; the reaper uses this. */
  lastUsed: number;
  /** True after the process emits a system/init event (or first byte). */
  ready: boolean;
  /** True after a 'close' or 'error' fires; we no longer write to this entry. */
  dead: boolean;
  /** Pending messages waiting for the current one to finish. */
  queue: QueuedMessage[];
  /** Active line handler for the in-flight message. */
  onLine: ((evt: Record<string, unknown>) => void) | null;
  /** Promise that resolves once we've seen system/init (gives us the real session id). */
  readyPromise: Promise<void>;
  /** Captured stdout buffer for split-line reassembly. */
  stdoutBuffer: string;
  /** Captured stderr (last 2KB) used in error messages. */
  stderrTail: string;
  /**
   * Path to the MCP config temp file baked into the process at spawn time.
   * Deleted when the process dies (via finalize) or when killProcess() runs.
   */
  mcpConfigPath: string | null;
}

const pool = new Map<string, PoolEntry>();

let reaperTimer: NodeJS.Timeout | null = null;

function ensureReaper() {
  if (reaperTimer) return;
  reaperTimer = setInterval(reapIdle, REAPER_INTERVAL_MS);
  // Don't keep Node alive just because of the reaper.
  if (typeof reaperTimer.unref === "function") reaperTimer.unref();
}

function reapIdle() {
  const now = Date.now();
  for (const [convId, entry] of pool.entries()) {
    if (entry.busy) continue;
    if (now - entry.lastUsed < IDLE_TTL_MS) continue;
    try {
      entry.proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    pool.delete(convId);
  }
}

/**
 * Spawn (or return cached) CLI process for `conversationId`.
 *
 * `existingSessionId` lets callers resume by passing the value persisted on
 * `ChatConversation.cliSessionId`. When omitted we mint a fresh UUID; the
 * caller should read the returned `entry.sessionId` and persist it.
 *
 * NOTE: the system prompt and tool list are baked into the process at spawn —
 * they cannot change for the lifetime of the process. If you need a new
 * prompt/toolset, `killProcess(conversationId)` first.
 */
function spawnPoolEntry(
  conversationId: string,
  systemPrompt: string,
  tools: ToolDefinition[],
  opts: {
    model?: string;
    binary?: string;
    existingSessionId?: string | null;
    mcpConfigPath?: string | null;
  } = {},
): PoolEntry {
  const model = opts.model ?? "sonnet";
  const binary = opts.binary ?? "claude";
  const sessionId = opts.existingSessionId || randomUUID();
  const mcpConfigPath = opts.mcpConfigPath ?? null;

  const fullSystemPrompt = buildSystemPrompt(systemPrompt, tools);

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--tools",
    "",
    "--model",
    model,
    "--session-id",
    sessionId,
    "--system-prompt",
    fullSystemPrompt,
  ];
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  // Strip Claude Code's nested-invocation markers so the spawned `claude`
  // doesn't think it's being launched from inside another Claude Code
  // session.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const proc = spawn(binary, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const entry: PoolEntry = {
    proc: proc as ChildProcessWithoutNullStreams,
    sessionId,
    busy: false,
    lastUsed: Date.now(),
    ready: false,
    dead: false,
    queue: [],
    onLine: null,
    readyPromise,
    stdoutBuffer: "",
    stderrTail: "",
    mcpConfigPath,
  };

  const initTimer = setTimeout(() => {
    if (!entry.ready) {
      rejectReady(
        new Error(
          `claude CLI did not produce an init event within ${SPAWN_INIT_TIMEOUT_MS}ms`,
        ),
      );
    }
  }, SPAWN_INIT_TIMEOUT_MS);
  if (typeof initTimer.unref === "function") initTimer.unref();

  proc.stdout.on("data", (chunk: Buffer) => {
    entry.stdoutBuffer += chunk.toString();
    let nl = entry.stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = entry.stdoutBuffer.slice(0, nl).trim();
      entry.stdoutBuffer = entry.stdoutBuffer.slice(nl + 1);
      if (line) {
        let evt: Record<string, unknown> | null = null;
        try {
          evt = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // ignore non-json line
        }
        if (evt) {
          // Watch for system/init to mark the process ready and capture the
          // real session_id the CLI chose (which may differ from ours if it
          // ever decides to remap).
          if (evt.type === "system" && (evt as { subtype?: string }).subtype === "init") {
            const sid = (evt as { session_id?: string }).session_id;
            if (typeof sid === "string" && sid) entry.sessionId = sid;
            if (!entry.ready) {
              entry.ready = true;
              clearTimeout(initTimer);
              resolveReady();
            }
          }
          if (entry.onLine) {
            try {
              entry.onLine(evt);
            } catch {
              /* swallow handler errors */
            }
          }
        }
      }
      nl = entry.stdoutBuffer.indexOf("\n");
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    entry.stderrTail = (entry.stderrTail + text).slice(-2048);
  });

  const finalize = (err: Error) => {
    entry.dead = true;
    clearTimeout(initTimer);
    if (!entry.ready) {
      try {
        rejectReady(err);
      } catch {
        /* already settled */
      }
    }
    pool.delete(conversationId);
    // Reject the in-flight message (if any) and all queued ones.
    const handler = entry.onLine;
    entry.onLine = null;
    if (handler) {
      try {
        handler({ type: "__abort__", error: err.message });
      } catch {
        /* ignore */
      }
    }
    while (entry.queue.length) {
      const m = entry.queue.shift();
      if (m) m.reject(err);
    }
    // Best-effort temp file cleanup for the MCP config (if any).
    void cleanupMcpConfig(entry.mcpConfigPath);
    entry.mcpConfigPath = null;
  };

  proc.on("close", (code) => {
    const tail = entry.stderrTail.slice(-400);
    finalize(
      new Error(
        `claude CLI process exited (code=${code ?? "null"})${tail ? `: ${tail}` : ""}`,
      ),
    );
  });

  proc.on("error", (err) => {
    finalize(new Error(`claude CLI spawn error: ${err.message}`));
  });

  pool.set(conversationId, entry);
  ensureReaper();
  return entry;
}

export interface SendMessageOptions {
  model?: string;
  binary?: string;
  /** Persisted session_id from `ChatConversation.cliSessionId`, if any. */
  existingSessionId?: string | null;
  /**
   * MCP config temp file path baked into the CLI on first spawn for this
   * conversation. The pool deletes the file when the process dies; callers
   * should NOT delete it themselves while the conversation is live. Ignored
   * when the conversation already has a pooled process — the value is fixed
   * at spawn time.
   */
  mcpConfigPath?: string | null;
}

export interface SendMessageResult extends CallClaudeCliResult {
  /** The session id the CLI is using; persist if it changed. */
  sessionId: string;
}

/**
 * Spawn or reuse the conversation's CLI process and send `userText`. Streams
 * text deltas via `onTextDelta`. Resolves with the final parsed reply
 * (including any TOOL_CALL invocations the model emitted).
 */
export async function sendMessage(
  conversationId: string,
  userText: string,
  systemPrompt: string,
  tools: ToolDefinition[],
  onTextDelta: ((delta: string) => void) | undefined,
  opts: SendMessageOptions = {},
): Promise<SendMessageResult> {
  let entry = pool.get(conversationId);
  if (!entry || entry.dead) {
    entry = spawnPoolEntry(conversationId, systemPrompt, tools, opts);
  } else if (opts.mcpConfigPath && opts.mcpConfigPath !== entry.mcpConfigPath) {
    // Caller built a fresh MCP config for this turn, but the pooled process
    // was spawned with the prior config (or none). The CLI doesn't let us
    // swap configs mid-process — we just discard the unused tempfile to
    // avoid leaks. Operators get the new config the next time the pool
    // entry is respawned (idle reap, kill, or crash).
    void cleanupMcpConfig(opts.mcpConfigPath);
  }

  // Wait for init before the first message; this is a no-op once ready.
  if (!entry.ready) {
    try {
      await entry.readyPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  // Queue if busy.
  if (entry.busy) {
    return new Promise<SendMessageResult>((resolve, reject) => {
      entry!.queue.push({
        userText,
        onTextDelta,
        resolve: (r) => resolve({ ...r, sessionId: entry!.sessionId }),
        reject,
      });
    });
  }

  return runMessage(entry, userText, onTextDelta);
}

function runMessage(
  entry: PoolEntry,
  userText: string,
  onTextDelta?: (delta: string) => void,
): Promise<SendMessageResult> {
  return new Promise<SendMessageResult>((resolve, reject) => {
    if (entry.dead) {
      reject(new Error("CLI process is dead"));
      return;
    }
    entry.busy = true;
    let accumulatedText = "";
    let settled = false;

    const finish = (err: Error | null, result?: CallClaudeCliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.busy = false;
      entry.onLine = null;
      entry.lastUsed = Date.now();
      drainQueue(entry);
      if (err) reject(err);
      else if (result) resolve({ ...result, sessionId: entry.sessionId });
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `claude CLI message timed out after ${PER_MESSAGE_TIMEOUT_MS}ms`,
        ),
      );
    }, PER_MESSAGE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    entry.onLine = (evt) => {
      // Abort signal from finalize().
      if (evt.type === "__abort__") {
        finish(new Error(String((evt as { error?: string }).error ?? "CLI process closed")));
        return;
      }

      if (evt.type === "stream_event") {
        const eventObj = evt.event as Record<string, unknown> | undefined;
        if (eventObj?.type === "content_block_delta") {
          const delta = eventObj.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            accumulatedText += delta.text;
            try {
              onTextDelta?.(delta.text);
            } catch {
              /* swallow */
            }
          }
        }
      } else if (evt.type === "result") {
        // Final wrapped result. Prefer `result` field when present; otherwise
        // fall back to whatever we accumulated via stream events.
        const resultText = (evt as { result?: string }).result;
        let finalText = accumulatedText;
        if (typeof resultText === "string" && resultText.length > accumulatedText.length) {
          // If the deltas didn't surface the full final text (rare), emit
          // the trailing slice so the caller's stream stays in sync.
          const tail = resultText.slice(accumulatedText.length);
          accumulatedText = resultText;
          finalText = resultText;
          try {
            onTextDelta?.(tail);
          } catch {
            /* swallow */
          }
        }

        const { toolCalls, firstMatchIndex } = parseToolCalls(finalText);
        if (toolCalls.length > 0) {
          const prose = finalText.slice(0, firstMatchIndex).trim();
          finish(null, { content: prose, toolCalls });
        } else {
          finish(null, { content: finalText.trim(), toolCalls: [] });
        }
      }
    };

    const envelope = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: userText }],
      },
      session_id: entry.sessionId,
      parent_tool_use_id: null,
    });

    try {
      entry.proc.stdin.write(envelope + "\n");
    } catch (err) {
      finish(
        new Error(
          `failed to write to claude CLI stdin: ${(err as Error).message}`,
        ),
      );
    }
  });
}

function drainQueue(entry: PoolEntry) {
  if (entry.dead) return;
  const next = entry.queue.shift();
  if (!next) return;
  runMessage(entry, next.userText, next.onTextDelta)
    .then(next.resolve)
    .catch(next.reject);
}

/**
 * Kill (and remove) the CLI process for a conversation. Safe to call on a
 * non-existent entry.
 */
export function killProcess(conversationId: string): void {
  const entry = pool.get(conversationId);
  if (!entry) return;
  try {
    entry.proc.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    entry.proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  // The proc's 'close' handler will also call cleanupMcpConfig via
  // finalize(), but call it here too to cover the race where the process
  // exits before the OS delivers the SIGTERM signal back to us.
  void cleanupMcpConfig(entry.mcpConfigPath);
  entry.mcpConfigPath = null;
  pool.delete(conversationId);
}

/** Test/diagnostics: returns the current pool size. */
export function poolSize(): number {
  return pool.size;
}

/** Test helper: returns the in-memory session id for a conversation, if any. */
export function getSessionId(conversationId: string): string | null {
  const e = pool.get(conversationId);
  return e ? e.sessionId : null;
}
