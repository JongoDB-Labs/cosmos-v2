import { PluginServerRegistry } from "@/lib/plugins/registry";
import { isPluginEnabled } from "@/lib/plugins/enablement";
import { KNOWN_DOMAINS, registerPluginToolDomain, type AgentDomain } from "./policy/domains";
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
  // `isPluginEnabled`, NOT `getEnabledPluginSlugs`: the latter reads only the
  // enabled flag, while this also checks the LICENCE. Using the cheaper one
  // would let a plugin whose entitlement has lapsed keep handing the assistant
  // tools after every other surface had stopped answering for it.
  const ok = await Promise.all(all.map((h) => isPluginEnabled(orgId, h.slug)));
  return all.filter((_, i) => ok[i]);
}

/**
 * A plugin tool's declared domain, or null when it has not declared a usable
 * one.
 *
 * Fail-closed on purpose. An undeclared tool would resolve to DEFAULT_DOMAIN
 * ("utility"), so an org that denied `work_items` would not block a plugin tool
 * that reads work items — the deny would appear to be in force while the tool
 * answered anyway. Dropping it is visible; mis-classifying it is not.
 */
function declaredDomain(t: ToolDefinition): AgentDomain | null {
  const d = t.domain;
  return typeof d === "string" && (KNOWN_DOMAINS as readonly string[]).includes(d)
    ? (d as AgentDomain)
    : null;
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
      const domain = declaredDomain(t);
      if (!domain) continue; // no usable domain ⇒ not offered at all
      taken.add(t.name);
      registerPluginToolDomain(t.name, domain);
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
      if (!declaredDomain(t)) continue; // never offered ⇒ never dispatched
      taken.add(t.name);
      if (t.name === name) return h.executeTool?.(name, args, ctx);
    }
  }
  return undefined;
}

/**
 * The slug of the enabled plugin that owns a tool name, or null.
 *
 * Used by the audit trail: a plugin tool is not in the core audit map, so
 * without this a plugin's WRITES would go unrecorded while every core
 * assistant write is logged.
 */
export async function pluginOwnerOf(orgId: string, name: string): Promise<string | null> {
  if (CORE_NAMES.has(name)) return null;
  const taken = new Set<string>(CORE_NAMES);
  for (const h of await enabledHooks(orgId)) {
    for (const t of h.aiTools ?? []) {
      if (taken.has(t.name) || !declaredDomain(t)) continue;
      taken.add(t.name);
      if (t.name === name) return h.slug;
    }
  }
  return null;
}
