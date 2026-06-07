// @vitest-environment node
//
// GOV GUARDRAILS — the security core of the runtime-config surface. Proves that a gov org's
// connector/agent posture is forced gov-safe (breadth/mcp off + commercial-only providers
// stripped), idempotently, and that the tenant-admin PATCH predicate rejects any attempt to
// lift those guardrails. Nango is the live commercial-only connector — register the real
// connectors so commercialOnlyProviders() resolves to ['nango'].
import { describe, it, expect, vi } from "vitest";
import "@/lib/ai/connectors"; // register the real descriptors (nango = commercial-only)
import { applyGovGuardrails, govGuardrailViolation } from "./guardrails";

describe("govGuardrailViolation — the tenant-admin PATCH predicate", () => {
  it("commercial: anything is allowed (no violation)", () => {
    expect(govGuardrailViolation("COMMERCIAL", { breadthEnabled: true })).toBeNull();
    expect(govGuardrailViolation("COMMERCIAL", { mcpEnabled: true })).toBeNull();
    expect(govGuardrailViolation("COMMERCIAL", { enabledConnectors: ["nango", "github"] })).toBeNull();
  });

  it("gov: enabling breadth is REJECTED", () => {
    expect(govGuardrailViolation("GOV", { breadthEnabled: true })).toMatch(/breadth|Nango/i);
  });

  it("gov: enabling mcp is REJECTED", () => {
    expect(govGuardrailViolation("GOV", { mcpEnabled: true })).toMatch(/MCP/i);
  });

  it("gov: listing a commercial-only connector (nango) is REJECTED", () => {
    expect(govGuardrailViolation("GOV", { enabledConnectors: ["github", "nango"] })).toMatch(/nango/i);
  });

  it("gov: a NATIVE-only allowlist + breadth/mcp false is ALLOWED", () => {
    expect(
      govGuardrailViolation("GOV", { enabledConnectors: ["github", "jira"], breadthEnabled: false, mcpEnabled: false }),
    ).toBeNull();
  });

  it("gov: enabledConnectors:null (all enabled) is ALLOWED (availability blocks nango anyway)", () => {
    expect(govGuardrailViolation("GOV", { enabledConnectors: null })).toBeNull();
  });
});

describe("applyGovGuardrails — forces the gov-safe posture (idempotent)", () => {
  function makeDb(existing: { enabledConnectors: string[] } | null) {
    const upsert = vi.fn().mockResolvedValue({});
    const db = {
      orgRuntimeConfig: {
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert,
      },
    };
    return { db, upsert };
  }

  it("forces breadth/mcp OFF and strips commercial-only providers (nango) from the allowlist", async () => {
    const { db, upsert } = makeDb({ enabledConnectors: ["github", "nango", "jira"] });
    await applyGovGuardrails("org-1", db);
    const arg = upsert.mock.calls[0][0];
    expect(arg.update.breadthEnabled).toBe(false);
    expect(arg.update.mcpEnabled).toBe(false);
    expect(arg.update.enabledConnectors).toEqual(["github", "jira"]); // nango stripped
  });

  it("upserts a gov-safe row when no config exists yet", async () => {
    const { db, upsert } = makeDb(null);
    await applyGovGuardrails("org-1", db);
    const arg = upsert.mock.calls[0][0];
    expect(arg.create.breadthEnabled).toBe(false);
    expect(arg.create.mcpEnabled).toBe(false);
  });

  it("is IDEMPOTENT: a second pass on an already-gov-safe row strips nothing further", async () => {
    const { db, upsert } = makeDb({ enabledConnectors: ["github", "jira"] }); // already stripped
    await applyGovGuardrails("org-1", db);
    expect(upsert.mock.calls[0][0].update.enabledConnectors).toEqual(["github", "jira"]);
  });
});
