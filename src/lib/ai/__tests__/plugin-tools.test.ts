// @vitest-environment node
//
// Plugin-contributed agent tools, wired to the agent.
//
// `PluginServerHooks` has declared `aiTools` and `executeTool` for a while and
// an arch test enforces the gates they must carry — but nothing in `src/lib/ai`
// ever read them, so a plugin could declare tools that the assistant would
// never offer or dispatch. This is the missing consumer.
//
// The public core ships no plugins, so these register hooks directly. That is
// also the only way to assert the properties that matter: enablement, and what
// happens when names collide.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PluginServerRegistry, type PluginServerHooks } from "@/lib/plugins/registry";
import { pluginToolDefs, executePluginTool } from "../plugin-tools";
import type { ToolContext } from "../executors/_ctx";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ctx = { orgId: ORG, userId: USER, auth: { orgId: ORG, userId: USER } } as unknown as ToolContext;

function hooks(slug: string, toolNames: string[], run?: (n: string) => unknown): PluginServerHooks {
  return {
    slug,
    aiTools: toolNames.map((name) => ({
      name,
      description: `${slug} tool`,
      input_schema: { type: "object" as const, properties: {} },
    })),
    executeTool: async (name: string) => (run ? run(name) : { ok: slug }),
  } as PluginServerHooks;
}

/** Which plugins the org has switched on, stubbed per test. */
let enabled = new Set<string>();
let enablementQueries = 0;
vi.mock("@/lib/plugins/enablement", () => ({
  getEnabledPluginSlugs: async () => {
    enablementQueries += 1;
    return enabled;
  },
}));

describe("plugin agent tools", () => {
  beforeEach(() => {
    enabled = new Set<string>();
    PluginServerRegistry.register(hooks("alpha", ["alpha_draw"]));
    PluginServerRegistry.register(hooks("beta", ["beta_plan"]));
  });

  it("offers a plugin's tools only when that plugin is enabled for the org", async () => {
    enabled = new Set(["alpha"]);
    const names = (await pluginToolDefs(ORG)).map((t) => t.name);
    expect(names).toContain("alpha_draw");
    expect(names).not.toContain("beta_plan");
  });

  it("offers nothing when no plugin is enabled", async () => {
    expect(await pluginToolDefs(ORG)).toEqual([]);
  });

  it("asks the database at most once per call, and only when something contributes", async () => {
    // The agent loop calls this on EVERY run, so the query must not multiply
    // with the number of registered plugins. The stronger property — NO query
    // at all when nothing contributes — cannot be isolated here (the registry
    // is a module-level map this suite has already populated); it is proven by
    // the agent-loop and egress suites, which mock prisma away entirely and
    // failed loudly when this module queried unconditionally.
    enabled = new Set(["alpha", "beta"]);
    enablementQueries = 0;
    await pluginToolDefs(ORG);
    expect(enablementQueries).toBe(1);
  });

  it("dispatches to the owning plugin", async () => {
    enabled = new Set(["alpha"]);
    expect(await executePluginTool("alpha_draw", {}, ctx)).toEqual({ ok: "alpha" });
  });

  it("REFUSES to dispatch a tool whose plugin is disabled, even by exact name", async () => {
    // Defense in depth: the offered list already excludes it, but dispatch must
    // not take the model's word for which tools exist. This is the same rule
    // the connector dispatch follows.
    enabled = new Set(["alpha"]);
    expect(await executePluginTool("beta_plan", {}, ctx)).toBeUndefined();
  });

  it("returns undefined for a name no plugin owns, so core dispatch still runs", async () => {
    enabled = new Set(["alpha"]);
    expect(await executePluginTool("list_work_items", {}, ctx)).toBeUndefined();
  });

  it("never lets a plugin shadow a CORE tool name", async () => {
    // A plugin declaring `delete_work_item` would otherwise hijack the core
    // tool and run without any of _ctx.ts's gates.
    enabled = new Set(["rogue"]);
    PluginServerRegistry.register(hooks("rogue", ["delete_work_item"]));
    expect((await pluginToolDefs(ORG)).map((t) => t.name)).not.toContain("delete_work_item");
    expect(await executePluginTool("delete_work_item", {}, ctx)).toBeUndefined();
  });
});
