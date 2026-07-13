/**
 * Tool-call status normalization for the chat UI.
 *
 * The assistant surfaces each tool call as a status chip ("Listing projects…",
 * "Updated work item"). Three shapes of tool call reach the renderer and they do
 * NOT agree on whether a `status` field is present:
 *
 *   1. LIVE, streaming    — the client mints `{…, status: "running"}` on
 *      `tool_call_start` and flips it to `"done"` on `tool_call_result`.
 *   2. The `done` SSE event — carries the agent loop's `AgentToolCall[]`
 *      (`{id, name, arguments, result}`) which has NO `status` field.
 *   3. PERSISTED history   — `AssistantMessage.toolCalls` is stored in the same
 *      status-less `AgentToolCall` shape, so a reopened conversation replays
 *      status-less chips.
 *
 * The original renderer treated "done" as `status === "done"`, so both (2) and
 * (3) — every finished tool call whose status was absent — rendered as the
 * spinning "running" state forever. These helpers make the state machine
 * explicit and default-closed: a chip is running ONLY when explicitly marked so;
 * everything else is done.
 */

export type ToolCallStatus = "running" | "done";

/** Loose shape accepted from any of the three sources above. */
export interface ToolCallLike {
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  status?: ToolCallStatus | string;
}

/**
 * A tool call is still running ONLY when it is explicitly marked `"running"`.
 * A `"done"` status, or NO status at all (the `done` event and persisted
 * history), means the call has completed — so it never spins. This is the fix
 * for chips stuck in the loading state after `done` and on conversation reload.
 */
export function isToolCallRunning(tc: ToolCallLike): boolean {
  return tc.status === "running";
}

/**
 * Force every tool call to `done`. Called when the turn completes (`done`
 * event) and when the stream closes or is aborted, so no chip is left spinning:
 * a tool call present on a completed/closed turn has, by definition, finished
 * (or will never report a result — either way it must stop spinning).
 */
export function finalizeToolCalls<T extends ToolCallLike>(
  tcs: readonly T[],
): (T & { status: ToolCallStatus })[] {
  return tcs.map((tc) => ({ ...tc, status: "done" as const }));
}

/**
 * True when any tool call in the list is still (explicitly) running — used to
 * decide whether a closing stream needs finalizing.
 */
export function hasRunningToolCall(tcs: readonly ToolCallLike[]): boolean {
  return tcs.some(isToolCallRunning);
}
