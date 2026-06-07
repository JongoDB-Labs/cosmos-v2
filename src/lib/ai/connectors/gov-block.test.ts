// @vitest-environment node
//
// D5 GOV-BLOCK — the load-bearing control of the Nango/commercial-breadth phase.
// A COMMERCIAL-ONLY connector must be UNREACHABLE to a gov tenant at EVERY layer.
// This file proves the connector-REGISTRY layers (L1 tool-list filter + L2 dispatch
// refusal) against a synthetic commercial-only fixture (isolation: resetConnectors).
// The agent-loop L1 wiring is proved in ../__tests__/agent-loop.test.ts; the Nango
// EXECUTOR (L3) + the connect ROUTE (L4) are proved in their own files.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the egress audit so an L2 refusal records an egress-decision WITHOUT a DB.
const logEgressDecision = vi.hoisted(() => vi.fn());
vi.mock("../egress/audit", () => ({ logEgressDecision }));

import {
  registerConnector,
  resetConnectors,
  connectorToolDefs,
  connectorToolNames,
  executeConnectorTool,
} from "./registry";
import type { ConnectorDescriptor } from "./types";

function makeDescriptor(over: Partial<ConnectorDescriptor> & { provider: string }): ConnectorDescriptor {
  return { toolDefs: [], execute: async () => ({}), egress: {}, ...over };
}

// An "all"-availability connector (the Google/GitHub case — unchanged for both classes).
const native = makeDescriptor({
  provider: "native_all",
  toolDefs: [{ name: "native_read", description: "r", input_schema: { type: "object", properties: {}, required: [] } }],
  execute: async (name) => ({ provider: "native_all", name }),
});

// A COMMERCIAL-ONLY connector (the Nango case — gov must NEVER reach it).
const commercialOnly = makeDescriptor({
  provider: "broker",
  availability: "commercial-only",
  toolDefs: [
    { name: "broker_proxy", description: "p", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "broker_list", description: "l", input_schema: { type: "object", properties: {}, required: [] } },
  ],
  execute: async (name, input) => ({ provider: "broker", name, input }),
});

beforeEach(() => {
  resetConnectors();
  logEgressDecision.mockClear();
  registerConnector(native);
  registerConnector(commercialOnly);
});

describe("L1 — tool-list derivation excludes commercial-only for gov", () => {
  it("gov sees NO commercial-only tools (only 'all' connectors)", () => {
    const govNames = connectorToolDefs("gov").map((t) => t.name);
    expect(govNames).toEqual(["native_read"]);
    expect(govNames).not.toContain("broker_proxy");
    expect(govNames).not.toContain("broker_list");
  });

  it("commercial sees BOTH the 'all' and the commercial-only tools", () => {
    const commNames = connectorToolDefs("commercial").map((t) => t.name);
    expect(commNames).toEqual(["native_read", "broker_proxy", "broker_list"]);
  });

  it("'all'-availability connector behavior is identical for both classes (unchanged)", () => {
    expect(connectorToolDefs("gov").map((t) => t.name)).toContain("native_read");
    expect(connectorToolDefs("commercial").map((t) => t.name)).toContain("native_read");
  });

  it("connectorToolNames is tenant-aware: a commercial-only name is NOT a gov member", () => {
    expect(connectorToolNames("gov").has("broker_proxy")).toBe(false);
    expect(connectorToolNames("commercial").has("broker_proxy")).toBe(true);
    // The unfiltered (no-class) set is the FULL set — dispatch uses it so a forged
    // gov call still routes into L2 (and is hard-refused there), not "Unknown tool".
    expect(connectorToolNames().has("broker_proxy")).toBe(true);
  });

  it("an omitted tenant class returns the full set (legacy static-catalog path)", () => {
    expect(connectorToolDefs().map((t) => t.name)).toEqual(["native_read", "broker_proxy", "broker_list"]);
  });
});

describe("L2 — executeConnectorTool dispatch refuses commercial-only for gov", () => {
  it("THROWS for a gov ctx on a commercial-only tool (defense in depth)", async () => {
    await expect(
      executeConnectorTool("broker_proxy", { q: 1 }, { orgId: "o", userId: "u", tenantClass: "gov" }),
    ).rejects.toThrow(/commercial-only|not available to a gov tenant|D5/i);
  });

  it("AUDITS the refusal as an egress decision (connector_availability_block), no CUI", async () => {
    await expect(
      executeConnectorTool("broker_proxy", { q: 1 }, { orgId: "o", userId: "u", tenantClass: "gov", conversationId: "c1" }),
    ).rejects.toThrow();
    expect(logEgressDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "broker_proxy",
        exposed: false,
        decidedBy: "connector_availability_block",
        tenantClass: "gov",
        conversationId: "c1",
      }),
    );
  });

  it("FAIL-CLOSED: refuses a commercial-only tool when the tenant class is ABSENT", async () => {
    await expect(
      executeConnectorTool("broker_list", {}, { orgId: "o", userId: "u" }),
    ).rejects.toThrow(/commercial-only|D5/i);
  });

  it("ALLOWS a commercial tenant to dispatch a commercial-only tool", async () => {
    const res = await executeConnectorTool("broker_proxy", { q: 2 }, { orgId: "o", userId: "u", tenantClass: "commercial" });
    expect(res).toEqual({ provider: "broker", name: "broker_proxy", input: { q: 2 } });
    expect(logEgressDecision).not.toHaveBeenCalled();
  });

  it("ALLOWS an 'all'-availability tool for BOTH classes (unchanged dispatch)", async () => {
    expect(await executeConnectorTool("native_read", {}, { orgId: "o", userId: "u", tenantClass: "gov" })).toEqual({
      provider: "native_all",
      name: "native_read",
    });
    expect(await executeConnectorTool("native_read", {}, { orgId: "o", userId: "u", tenantClass: "commercial" })).toEqual({
      provider: "native_all",
      name: "native_read",
    });
    expect(logEgressDecision).not.toHaveBeenCalled();
  });
});
