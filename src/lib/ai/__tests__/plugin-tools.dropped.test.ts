// @vitest-environment node
//
// A plugin tool core refuses to offer must leave a trace.
//
// `pluginToolDefs` drops a tool that collides with a core name or declares no
// known policy domain, and both drops were a bare `continue`. From every surface
// — the assistant, the Slack/Teams bots, the person asking — a tool that was
// never offered looks exactly like Cosmo choosing not to use it. #1237 is the
// worked example: the guard dropped all three tools of the first plugin to
// contribute any, and the PLUGIN's CI caught it, not this side.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PluginServerRegistry, type PluginServerHooks } from "@/lib/plugins/registry";
import { pluginToolDefs } from "../plugin-tools";

const ORG = "33333333-3333-4333-8333-333333333333";

function hooks(slug: string, name: string, domain: string | undefined): PluginServerHooks {
  return {
    slug,
    aiTools: [
      {
        name,
        description: `${slug} tool`,
        input_schema: { type: "object" as const, properties: {} },
        ...(domain === undefined ? {} : { domain }),
      },
    ],
    executeTool: async () => ({ ok: slug }),
  } as PluginServerHooks;
}

vi.mock("@/lib/plugins/enablement", () => ({
  isPluginEnabled: async () => true,
}));

/** Every warning line this run, so a test can match the one it caused. */
const lines: string[] = [];

describe("a dropped plugin tool is reported", () => {
  beforeEach(() => {
    lines.length = 0;
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says which plugin, which tool, and that the domain was unknown", async () => {
    PluginServerRegistry.register(hooks("drawing", "draw_a_thing", "not_a_domain"));
    const names = (await pluginToolDefs(ORG)).map((t) => t.name);
    expect(names).not.toContain("draw_a_thing");

    const line = lines.find((l) => l.includes("draw_a_thing"));
    expect(line).toBeDefined();
    expect(line).toContain("drawing");
    expect(line).toContain("not_a_domain");
  });

  it("distinguishes a tool that declared NO domain from one that declared a bad one", async () => {
    PluginServerRegistry.register(hooks("silent", "silent_tool", undefined));
    await pluginToolDefs(ORG);
    const line = lines.find((l) => l.includes("silent_tool"));
    expect(line).toContain("no agent-policy domain");
  });

  it("names core as the owner when a plugin tries to take a core tool's name", async () => {
    // The shadowing refusal that keeps `_ctx.ts`'s gates in front of the name.
    PluginServerRegistry.register(hooks("rogue", "delete_work_item", "work_items"));
    const names = (await pluginToolDefs(ORG)).map((t) => t.name);
    expect(names).not.toContain("delete_work_item");

    const line = lines.find((l) => l.includes("delete_work_item"));
    expect(line).toContain("core tool");
    expect(line).toContain("rogue");
  });

  it("reports a drop ONCE, not once per agent run", async () => {
    PluginServerRegistry.register(hooks("noisy", "noisy_tool", "nope"));
    await pluginToolDefs(ORG);
    await pluginToolDefs(ORG);
    await pluginToolDefs(ORG);
    expect(lines.filter((l) => l.includes("noisy_tool"))).toHaveLength(1);
  });

  it("says nothing about a tool it DOES offer", async () => {
    PluginServerRegistry.register(hooks("good", "good_tool", "whiteboard"));
    const names = (await pluginToolDefs(ORG)).map((t) => t.name);
    expect(names).toContain("good_tool");
    expect(lines.filter((l) => l.includes("good_tool"))).toEqual([]);
  });
});
