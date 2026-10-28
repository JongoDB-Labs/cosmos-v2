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
import { domainForTool } from "../policy/domains";
import type { ToolContext } from "../executors/_ctx";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ctx = { orgId: ORG, userId: USER, auth: { orgId: ORG, userId: USER } } as unknown as ToolContext;

function hooks(
  slug: string,
  toolNames: string[],
  opts: { domain?: string | undefined } = {},
): PluginServerHooks {
  const domain = "domain" in opts ? opts.domain : "work_items";
  return {
    slug,
    aiTools: toolNames.map((name) => ({
      name,
      description: `${slug} tool`,
      input_schema: { type: "object" as const, properties: {} },
      ...(domain === undefined ? {} : { domain }),
    })),
    executeTool: async () => ({ ok: slug }),
  } as PluginServerHooks;
}

/** Which plugins the org has switched on, stubbed per test. */
/**
 * `isPluginEnabled` is what the module calls, and the choice is the point: it
 * checks the LICENCE as well as the enabled flag, where `getEnabledPluginSlugs`
 * checks only the flag.
 */
let enabled = new Set<string>();
let licensed = new Set<string>();
let enablementQueries = 0;
vi.mock("@/lib/plugins/enablement", () => ({
  isPluginEnabled: async (_orgId: string, slug: string) => {
    enablementQueries += 1;
    return enabled.has(slug) && licensed.has(slug);
  },
}));

describe("plugin agent tools", () => {
  beforeEach(() => {
    enabled = new Set<string>();
    licensed = new Set(["alpha", "beta", "rogue", "undeclared", "bogus"]);
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

  it("offers nothing for a plugin that is enabled but NOT LICENSED", async () => {
    // The parity that matters: every other surface stops answering for a
    // plugin whose entitlement lapsed. The assistant must stop too, rather
    // than remaining the one door still open.
    enabled = new Set(["alpha"]);
    licensed = new Set<string>();
    expect(await pluginToolDefs(ORG)).toEqual([]);
    expect(await executePluginTool("alpha_draw", {}, ctx)).toBeUndefined();
  });

  it("drops a tool that declares no domain, or an unknown one", async () => {
    // An undeclared tool would resolve to DEFAULT_DOMAIN ("utility"), so an org
    // denying `work_items` would not block a plugin tool that reads them — the
    // deny would look enforced while the tool answered. Fail closed instead.
    PluginServerRegistry.register(hooks("undeclared", ["undeclared_tool"], { domain: undefined }));
    PluginServerRegistry.register(hooks("bogus", ["bogus_tool"], { domain: "not_a_domain" }));
    enabled = new Set(["undeclared", "bogus"]);
    const names = (await pluginToolDefs(ORG)).map((t) => t.name);
    expect(names).not.toContain("undeclared_tool");
    expect(names).not.toContain("bogus_tool");
    expect(await executePluginTool("undeclared_tool", {}, ctx)).toBeUndefined();
  });

  it("makes a plugin tool's declared domain visible to the agent policy", async () => {
    enabled = new Set(["alpha"]);
    await pluginToolDefs(ORG);
    expect(domainForTool("alpha_draw")).toBe("work_items");
  });

  it("asks the database at most once per contributing plugin", async () => {
    // The agent loop calls this on EVERY run, so the query must not multiply
    // with the number of registered plugins. The stronger property — NO query
    // at all when nothing contributes — cannot be isolated here (the registry
    // is a module-level map this suite has already populated); it is proven by
    // the agent-loop and egress suites, which mock prisma away entirely and
    // failed loudly when this module queried unconditionally.
    enabled = new Set(["alpha", "beta"]);
    enablementQueries = 0;
    await pluginToolDefs(ORG);
    // One per registered contributor, not one per TOOL — a plugin with twenty
    // tools must not cost twenty licence checks.
    expect(enablementQueries).toBe(PluginServerRegistry.getAll().filter((h) => (h.aiTools?.length ?? 0) > 0).length);
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
