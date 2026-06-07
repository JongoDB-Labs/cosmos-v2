// @vitest-environment node
//
// GUI runtime-config (design §8) — per-org CONNECTOR ENABLEMENT gating of the connector
// tool list + dispatch. Proves the ADDITIVE filter on connectorToolDefs/connectorToolNames/
// executeConnectorTool against synthetic fixtures (isolation: resetConnectors):
//   - a disabled connector's tools are ABSENT from the list AND dispatch REFUSES it;
//   - breadthEnabled=false hides a breadth (commercial-only) connector even for commercial;
//   - the DEFAULT (no filter / null allowlist) preserves CURRENT behavior (all enabled).
// The real-connector default case stays locked by invariant.test.ts; this file proves the
// new narrowing in isolation.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the egress audit so a dispatch refusal records an egress-decision WITHOUT a DB.
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

// Three native "all"-availability connectors (the Google/GitHub/Jira/Slack case).
const github = makeDescriptor({
  provider: "github",
  toolDefs: [{ name: "github_list_issues", description: "i", input_schema: { type: "object", properties: {}, required: [] } }],
  execute: async (name, input) => ({ provider: "github", name, input }),
});
const jira = makeDescriptor({
  provider: "jira",
  toolDefs: [{ name: "jira_search_issues", description: "i", input_schema: { type: "object", properties: {}, required: [] } }],
  execute: async (name, input) => ({ provider: "jira", name, input }),
});
const slack = makeDescriptor({
  provider: "slack",
  toolDefs: [{ name: "slack_list_channels", description: "c", input_schema: { type: "object", properties: {}, required: [] } }],
  execute: async (name, input) => ({ provider: "slack", name, input }),
});
// A BREADTH (commercial-only) connector — the Nango case the breadth toggle governs.
const nango = makeDescriptor({
  provider: "nango",
  availability: "commercial-only",
  toolDefs: [{ name: "nango_proxy_request", description: "p", input_schema: { type: "object", properties: {}, required: [] } }],
  execute: async (name, input) => ({ provider: "nango", name, input }),
});

beforeEach(() => {
  resetConnectors();
  logEgressDecision.mockClear();
  registerConnector(github);
  registerConnector(jira);
  registerConnector(slack);
  registerConnector(nango);
});

describe("DEFAULT (no filter / null allowlist) preserves current behavior", () => {
  it("omitting the filter ⇒ full set for commercial (today's behavior)", () => {
    expect(connectorToolDefs("commercial").map((t) => t.name)).toEqual([
      "github_list_issues", "jira_search_issues", "slack_list_channels", "nango_proxy_request",
    ]);
  });

  it("a null allowlist + breadth on ⇒ all enabled (the getRuntimeConfig default)", () => {
    const names = connectorToolDefs("commercial", { enabledConnectors: null, breadthEnabled: true }).map((t) => t.name);
    expect(names).toEqual(["github_list_issues", "jira_search_issues", "slack_list_channels", "nango_proxy_request"]);
  });

  it("a gov tenant with the default filter still excludes the breadth connector (gov-block unchanged)", () => {
    const names = connectorToolDefs("gov", { enabledConnectors: null, breadthEnabled: true }).map((t) => t.name);
    expect(names).toEqual(["github_list_issues", "jira_search_issues", "slack_list_channels"]);
    expect(names).not.toContain("nango_proxy_request");
  });
});

describe("a per-org ALLOWLIST narrows the offered tools", () => {
  it("enabledConnectors:['github'] ⇒ only github's tools (jira/slack/nango absent)", () => {
    const names = connectorToolDefs("commercial", { enabledConnectors: ["github"], breadthEnabled: true }).map((t) => t.name);
    expect(names).toEqual(["github_list_issues"]);
    expect(names).not.toContain("jira_search_issues");
    expect(names).not.toContain("slack_list_channels");
    expect(names).not.toContain("nango_proxy_request");
  });

  it("connectorToolNames honors the allowlist too (membership narrows)", () => {
    const names = connectorToolNames("commercial", { enabledConnectors: ["github"], breadthEnabled: true });
    expect(names.has("github_list_issues")).toBe(true);
    expect(names.has("jira_search_issues")).toBe(false);
    expect(names.has("nango_proxy_request")).toBe(false);
  });

  it("an EMPTY allowlist ⇒ NO connector tools", () => {
    expect(connectorToolDefs("commercial", { enabledConnectors: [], breadthEnabled: true })).toEqual([]);
  });
});

describe("breadthEnabled=false hides the breadth connector EVEN for commercial", () => {
  it("breadthEnabled:false drops nango for commercial (native connectors stay)", () => {
    const names = connectorToolDefs("commercial", { enabledConnectors: null, breadthEnabled: false }).map((t) => t.name);
    expect(names).toEqual(["github_list_issues", "jira_search_issues", "slack_list_channels"]);
    expect(names).not.toContain("nango_proxy_request");
  });

  it("nango in the allowlist but breadthEnabled:false ⇒ still hidden (breadth gate wins)", () => {
    const names = connectorToolDefs("commercial", { enabledConnectors: ["github", "nango"], breadthEnabled: false }).map((t) => t.name);
    expect(names).toEqual(["github_list_issues"]);
    expect(names).not.toContain("nango_proxy_request");
  });
});

describe("DISPATCH refuses a connector the org disabled (defense in depth)", () => {
  it("REJECTS a tool whose provider is not in the allowlist (commercial)", async () => {
    await expect(
      executeConnectorTool(
        "jira_search_issues", { q: 1 },
        { orgId: "o", userId: "u", tenantClass: "commercial", conversationId: "c1", enabled: { enabledConnectors: ["github"], breadthEnabled: true } },
      ),
    ).rejects.toThrow(/DISABLED by this org's runtime config|runtime-config gate/i);
    expect(logEgressDecision).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "jira_search_issues", exposed: false, decidedBy: "connector_disabled_block", conversationId: "c1" }),
    );
  });

  it("REJECTS a breadth tool when breadthEnabled:false (commercial)", async () => {
    await expect(
      executeConnectorTool(
        "nango_proxy_request", {},
        { orgId: "o", userId: "u", tenantClass: "commercial", enabled: { enabledConnectors: null, breadthEnabled: false } },
      ),
    ).rejects.toThrow(/runtime-config gate|DISABLED/i);
  });

  it("ALLOWS an enabled connector's tool (no refusal, no audit)", async () => {
    const res = await executeConnectorTool(
      "github_list_issues", { q: 2 },
      { orgId: "o", userId: "u", tenantClass: "commercial", enabled: { enabledConnectors: ["github"], breadthEnabled: true } },
    );
    expect(res).toEqual({ provider: "github", name: "github_list_issues", input: { q: 2 } });
    expect(logEgressDecision).not.toHaveBeenCalled();
  });

  it("ABSENT filter ⇒ no extra narrowing (dispatch unchanged for enabled connectors)", async () => {
    const res = await executeConnectorTool(
      "jira_search_issues", {},
      { orgId: "o", userId: "u", tenantClass: "commercial" },
    );
    expect(res).toEqual({ provider: "jira", name: "jira_search_issues", input: {} });
    expect(logEgressDecision).not.toHaveBeenCalled();
  });

  it("the gov-block (availability) still wins for a breadth tool regardless of the filter", async () => {
    // A gov tenant calling a breadth tool is refused by the AVAILABILITY block (L2), not the
    // runtime-config gate — the availability check runs first.
    await expect(
      executeConnectorTool(
        "nango_proxy_request", {},
        { orgId: "o", userId: "u", tenantClass: "gov", enabled: { enabledConnectors: ["nango"], breadthEnabled: true } },
      ),
    ).rejects.toThrow(/commercial-only|gov tenant|D5/i);
    expect(logEgressDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decidedBy: "connector_availability_block" }),
    );
  });
});
