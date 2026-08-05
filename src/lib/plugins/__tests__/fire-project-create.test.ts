// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * firePluginProjectCreate fans a project-created event out to every enabled
 * plugin's onProjectCreate. The load-bearing property is that it is BEST-EFFORT:
 * a plugin hook must never be able to fail core project creation, so one that
 * throws is logged and the others still run.
 */

const findMany = vi.fn();
vi.mock("@/lib/db/client", () => ({ prisma: { orgPluginState: { findMany } } }));

const get = vi.fn();
vi.mock("../registry", () => ({
  PluginRegistry: { get: vi.fn() },
  PluginServerRegistry: { get },
}));
// Heavy / side-effecting imports enablement.ts pulls — stubbed so the unit runs
// in isolation.
vi.mock("../registry/server", () => ({}));
vi.mock("../default-env", () => ({ resolveDefaultPlugins: () => [] }));
vi.mock("@/lib/brand", () => ({ getBrand: vi.fn() }));

const { firePluginProjectCreate } = await import("../enablement");

const ORG = "org-1";
const PROJECT = "proj-1";

function enabled(...slugs: string[]) {
  findMany.mockResolvedValue(slugs.map((pluginSlug) => ({ pluginSlug })));
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockReturnValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("firePluginProjectCreate", () => {
  it("calls onProjectCreate for each enabled plugin, with org + project", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    enabled("alpha", "beta");
    get.mockImplementation((s: string) => ({ alpha: { onProjectCreate: a }, beta: { onProjectCreate: b } })[s]);

    await firePluginProjectCreate(ORG, PROJECT);

    expect(a).toHaveBeenCalledWith(expect.anything(), ORG, PROJECT);
    expect(b).toHaveBeenCalledWith(expect.anything(), ORG, PROJECT);
  });

  it("keeps going when one plugin's hook throws — the others still run", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("plugin blew up"));
    const ok = vi.fn().mockResolvedValue(undefined);
    enabled("alpha", "beta");
    get.mockImplementation((s: string) => ({ alpha: { onProjectCreate: boom }, beta: { onProjectCreate: ok } })[s]);

    // Must not reject — a plugin failure cannot bubble into project creation.
    await expect(firePluginProjectCreate(ORG, PROJECT)).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalled();
  });

  it("skips a plugin that does not implement the hook", async () => {
    enabled("alpha");
    get.mockReturnValue({ /* no onProjectCreate */ });
    await expect(firePluginProjectCreate(ORG, PROJECT)).resolves.toBeUndefined();
  });

  it("does nothing when no plugin is enabled", async () => {
    enabled();
    await firePluginProjectCreate(ORG, PROJECT);
    expect(get).not.toHaveBeenCalled();
  });
});
