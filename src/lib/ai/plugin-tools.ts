import { PluginServerRegistry } from "@/lib/plugins/registry";
import { getEnabledPluginSlugs } from "@/lib/plugins/enablement";
import { cosmosTools, type ToolDefinition } from "./tools";
import type { ToolContext } from "./executors/_ctx";

/**
 * Agent tools contributed by plugins — the consumer for a contract that had
 * none.
 *
 * `PluginServerHooks.aiTools` / `.executeTool` have been part of the plugin
 * contract for a long time, and `plugin-tool-scope.arch.test.ts` enforces the
 * gates such a tool must carry. Nothing in `src/lib/ai` ever READ them, so a
 * plugin could declare tools the assistant would neither offer nor dispatch.
 * This module is that missing half.
 *
 * Two rules do the real work here, and both exist because a tool name is
 * attacker-adjacent: the model picks it, and a plugin author chooses it.
 *
 *   ENABLEMENT. A plugin's tools are offered only to an org that has the plugin
 *   switched on, and dispatch checks again rather than trusting the offered
 *   list. The connector path takes the same belt-and-braces approach, for the
 *   same reason: the offered set and the dispatcher are different code, and
 *   only one of them is in the model's prompt.
 *
 *   CORE WINS. A plugin may never take a name a core tool already uses. A
 *   plugin declaring `delete_work_item` would otherwise shadow the core tool
 *   and run with none of `_ctx.ts`'s gates — the plugin dispatch path does not
 *   pass through them. Shadowed names are dropped from the offered list AND
 *   refused at dispatch, so the core tool keeps the name in both places.
 */

/** Core tool names, which no plugin may take. Computed once; `cosmosTools` is static. */
const CORE_NAMES: ReadonlySet<string> = new Set(cosmosTools.map((t) => t.name));

/** Registered plugins that actually contribute a tool. */
function contributors() {
  return PluginServerRegistry.getAll().filter((h) => (h.aiTools?.length ?? 0) > 0);
}

/**
 * Hooks for the plugins this org has enabled, in registry order.
 *
 * Returns early when NOTHING contributes a tool, before asking the database
 * which plugins are on. That is the common case — the public core registers no
 * plugins at all — and it keeps a per-run query off the agent's hot path
 * instead of paying it to learn there was nothing to add.
 */
async function enabledHooks(orgId: string) {
  const all = contributors();
  if (all.length === 0) return [];
  const enabled = await getEnabledPluginSlugs(orgId);
  return all.filter((h) => enabled.has(h.slug));
}

/**
 * Tool definitions from every plugin enabled for this org, minus any that
 * collide with a core tool or with a plugin already seen.
 *
 * A collision between two PLUGINS resolves to the first registered rather than
 * the last, so enabling a plugin cannot silently repoint a name another plugin
 * already owned.
 */
export async function pluginToolDefs(orgId: string): Promise<ToolDefinition[]> {
  const out: ToolDefinition[] = [];
  const taken = new Set<string>(CORE_NAMES);
  for (const h of await enabledHooks(orgId)) {
    for (const t of h.aiTools ?? []) {
      if (taken.has(t.name)) continue;
      taken.add(t.name);
      out.push(t);
    }
  }
  return out;
}

/**
 * Run a plugin tool, or return `undefined` when no enabled plugin owns the
 * name — which is how the core dispatcher knows to carry on to its own switch.
 *
 * `undefined` is deliberately the answer for a DISABLED plugin's tool too: the
 * caller should treat it exactly like a name nobody owns, and end at the core
 * dispatcher's "Unknown tool", rather than learning that the tool exists but is
 * switched off.
 */
export async function executePluginTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown | undefined> {
  if (CORE_NAMES.has(name)) return undefined; // core owns it; never reachable here
  const taken = new Set<string>(CORE_NAMES);
  for (const h of await enabledHooks(ctx.orgId)) {
    for (const t of h.aiTools ?? []) {
      if (taken.has(t.name)) continue;
      taken.add(t.name);
      if (t.name === name) return h.executeTool?.(name, args, ctx);
    }
  }
  return undefined;
}
