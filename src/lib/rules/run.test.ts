// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, enablement, registry } = vi.hoisted(() => ({
  prisma: {},
  enablement: { isPluginEnabled: vi.fn() },
  registry: { PluginServerRegistry: { getAll: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/plugins/enablement", () => enablement);
vi.mock("@/lib/plugins/registry", () => registry);

import { runOrgRules } from "./run";

const ORG = "org-1";
const summary = (rule: string) => ({ rule, raised: 1, resolved: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  enablement.isPluginEnabled.mockResolvedValue(true);
});

describe("runOrgRules", () => {
  it("runs every enabled plugin that has rules", async () => {
    const a = vi.fn().mockResolvedValue([summary("a.one")]);
    const b = vi.fn().mockResolvedValue([summary("b.one")]);
    registry.PluginServerRegistry.getAll.mockReturnValue([
      { slug: "a", runRules: a },
      { slug: "b", runRules: b },
    ]);
    const out = await runOrgRules(ORG);
    expect(a).toHaveBeenCalledWith(prisma, ORG);
    expect(b).toHaveBeenCalledWith(prisma, ORG);
    expect(out.ok).toBe(true);
    expect(out.plugins.map((p) => p.slug)).toEqual(["a", "b"]);
  });

  it("ignores plugins that declare no rules", async () => {
    registry.PluginServerRegistry.getAll.mockReturnValue([{ slug: "a" }, { slug: "b", runRules: vi.fn().mockResolvedValue([]) }]);
    const out = await runOrgRules(ORG);
    expect(out.plugins.map((p) => p.slug)).toEqual(["b"]);
  });

  it("does not run a plugin that is disabled or unlicensed for the org", async () => {
    const a = vi.fn().mockResolvedValue([]);
    registry.PluginServerRegistry.getAll.mockReturnValue([{ slug: "a", runRules: a }]);
    enablement.isPluginEnabled.mockResolvedValue(false);
    const out = await runOrgRules(ORG);
    expect(a).not.toHaveBeenCalled();
    expect(out.plugins).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it("one plugin throwing does NOT starve the ones after it", async () => {
    // On a timer this is not a one-off: the same plugin fails first every run,
    // so without isolation every later plugin's rules stop for good, silently.
    const boom = vi.fn().mockRejectedValue(new Error("kaboom"));
    const after = vi.fn().mockResolvedValue([summary("b.one")]);
    registry.PluginServerRegistry.getAll.mockReturnValue([
      { slug: "a", runRules: boom },
      { slug: "b", runRules: after },
    ]);
    const out = await runOrgRules(ORG);
    expect(after).toHaveBeenCalledOnce();
    expect(out.plugins.find((p) => p.slug === "b")).toMatchObject({ ok: true });
  });

  it("REPORTS the failure rather than swallowing it", async () => {
    // A scheduled run that always claims success hides a rule that stopped
    // working months ago.
    registry.PluginServerRegistry.getAll.mockReturnValue([
      { slug: "a", runRules: vi.fn().mockRejectedValue(new Error("kaboom")) },
    ]);
    const out = await runOrgRules(ORG);
    expect(out.ok).toBe(false);
    expect(out.plugins[0]).toMatchObject({ slug: "a", ok: false, error: "kaboom" });
  });

  it("survives a plugin that rejects with a non-Error", async () => {
    registry.PluginServerRegistry.getAll.mockReturnValue([
      { slug: "a", runRules: vi.fn().mockRejectedValue("just a string") },
    ]);
    const out = await runOrgRules(ORG);
    expect(out.ok).toBe(false);
    expect(out.plugins[0]).toMatchObject({ error: "just a string" });
  });

  it("treats a plugin returning nothing as an empty run, not a crash", async () => {
    registry.PluginServerRegistry.getAll.mockReturnValue([
      { slug: "a", runRules: vi.fn().mockResolvedValue(undefined) },
    ]);
    const out = await runOrgRules(ORG);
    expect(out.plugins[0]).toMatchObject({ ok: true, rules: [] });
  });

  it("is ok with nothing to do at all", async () => {
    registry.PluginServerRegistry.getAll.mockReturnValue([]);
    expect(await runOrgRules(ORG)).toEqual({ ok: true, plugins: [] });
  });

  it("carries each rule's counts back to the caller", async () => {
    registry.PluginServerRegistry.getAll.mockReturnValue([
      { slug: "a", runRules: vi.fn().mockResolvedValue([{ rule: "a.burn", raised: 3, resolved: 2, notified: 1 }]) },
    ]);
    const out = await runOrgRules(ORG);
    expect(out.plugins[0]).toMatchObject({
      ok: true,
      rules: [{ rule: "a.burn", raised: 3, resolved: 2, notified: 1 }],
    });
  });
});
