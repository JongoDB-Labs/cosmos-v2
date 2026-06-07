// @vitest-environment node
//
// The runtime-config loader — proves the tri-state collapse (allowlistEnabled flag +
// enabledConnectors array → string[] | null) and the LOAD-BEARING default: a MISSING row
// resolves to "all enabled / breadth on / mcp off" = today's behavior.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { orgRuntimeConfig: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { getRuntimeConfig, normalizeRuntimeConfig, DEFAULT_RUNTIME_CONFIG } from "./index";

beforeEach(() => prisma.orgRuntimeConfig.findUnique.mockReset());

describe("normalizeRuntimeConfig — tri-state collapse", () => {
  it("allowlistEnabled=false ⇒ enabledConnectors:null (all enabled), ignoring the array", () => {
    expect(
      normalizeRuntimeConfig({ allowlistEnabled: false, enabledConnectors: ["github"], breadthEnabled: true, mcpEnabled: false }),
    ).toEqual({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false });
  });

  it("allowlistEnabled=true ⇒ the explicit subset is used", () => {
    expect(
      normalizeRuntimeConfig({ allowlistEnabled: true, enabledConnectors: ["github", "jira"], breadthEnabled: false, mcpEnabled: true }),
    ).toEqual({ enabledConnectors: ["github", "jira"], breadthEnabled: false, mcpEnabled: true });
  });

  it("allowlistEnabled=true + empty array ⇒ NONE enabled ([] not null)", () => {
    expect(
      normalizeRuntimeConfig({ allowlistEnabled: true, enabledConnectors: [], breadthEnabled: true, mcpEnabled: false }).enabledConnectors,
    ).toEqual([]);
  });
});

describe("getRuntimeConfig — the missing-row default", () => {
  it("a MISSING row ⇒ DEFAULT_RUNTIME_CONFIG (all enabled / breadth on / mcp off)", async () => {
    prisma.orgRuntimeConfig.findUnique.mockResolvedValue(null);
    expect(await getRuntimeConfig("org-1")).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(DEFAULT_RUNTIME_CONFIG).toEqual({ enabledConnectors: null, breadthEnabled: true, mcpEnabled: false });
  });

  it("an existing row is normalized", async () => {
    prisma.orgRuntimeConfig.findUnique.mockResolvedValue({
      allowlistEnabled: true, enabledConnectors: ["github"], breadthEnabled: false, mcpEnabled: false,
    });
    expect(await getRuntimeConfig("org-1")).toEqual({ enabledConnectors: ["github"], breadthEnabled: false, mcpEnabled: false });
  });
});
