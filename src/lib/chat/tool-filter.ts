import type { ToolDefinition } from "@/lib/ai/tools";
import type { ChatBotToolScope } from "@prisma/client";

/**
 * Tool-scope ceiling for first-class chat bots.
 *
 * A bot's `toolScope` is a HARD CEILING applied on top of the invoking human's
 * own per-tool permission scoping (see bot-runner.ts / agent-loop.ts — every
 * tool still runs via `executeTool(..., { userId: invoker })`). The scope only
 * ever REMOVES tools, never grants any:
 *
 *   NONE     → no cosmos tools at all (the bot is a chat-only persona).
 *   READONLY → only tools that read, query, or search — NEVER a tool that
 *              creates, updates, deletes, logs, or sends. A READONLY bot
 *              reaching a mutation tool is a privilege-escalation bug, so this
 *              is an explicit ALLOW-list keyed by exact tool name plus a
 *              conservative read-prefix fallback (the query, list, get, search,
 *              and read prefixes). Anything not provably read-only is excluded.
 *   FULL     → the whole catalog (still perm-scoped to the invoker).
 *
 * NOTE (v2): this is a tool *visibility* ceiling. The tools that DO survive
 * still pass through v2's CUI-blind egress gate inside `runAgentLoop` — their
 * RESULTS are projected under the data-driven MAC ceiling before re-entering the
 * model. The scope filter and the egress gate are independent layers.
 */

/**
 * Tools that are unambiguously read-only but whose names don't start with a
 * read prefix (so the prefix heuristic alone would drop them). Listed
 * explicitly so READONLY bots keep useful read capabilities.
 */
const READONLY_EXPLICIT = new Set<string>([
  "semantic_search",
  "generate_cycle_brief", // composes a status brief from read queries only
  "fetch_url", // fetches a URL's text; no cosmos mutation
]);

/**
 * Name prefixes that denote a read-only operation. Conservative on purpose:
 * a tool only counts as readable if it matches one of these prefixes OR is in
 * the explicit set above. Everything else (create_/update_/delete_/log_/
 * send_/process_/add_/...) is treated as a mutation and excluded from READONLY.
 */
const READONLY_PREFIXES = ["query_", "list_", "get_", "search_", "read_"];

function isReadOnlyTool(name: string): boolean {
  if (READONLY_EXPLICIT.has(name)) return true;
  return READONLY_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Apply a bot's tool-scope ceiling to a candidate tool list. Returns a new
 * filtered array; never mutates the input.
 */
export function filterToolsByScope(
  scope: ChatBotToolScope,
  tools: ToolDefinition[],
): ToolDefinition[] {
  switch (scope) {
    case "NONE":
      return [];
    case "READONLY":
      return tools.filter((t) => isReadOnlyTool(t.name));
    case "FULL":
      return tools;
    default: {
      // Unknown/unhandled scope → fail closed (no tools). Exhaustiveness guard.
      const _exhaustive: never = scope;
      void _exhaustive;
      return [];
    }
  }
}
