// @vitest-environment node
//
// Unit test for the connector registry — routing, egress merge, and the
// fail-loud duplicate/collision detection. Uses synthetic fixture descriptors
// (NOT the real google/github connectors) so the contract is tested in isolation;
// resetConnectors() clears any global registration between cases.
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerConnector,
  resetConnectors,
  getConnectorDescriptors,
  connectorToolDefs,
  connectorToolNames,
  executeConnectorTool,
  connectorEgressMaps,
} from "./registry";
import type { ConnectorDescriptor } from "./types";

function makeDescriptor(over: Partial<ConnectorDescriptor> & { provider: string }): ConnectorDescriptor {
  return {
    toolDefs: [],
    execute: async () => ({}),
    egress: {},
    ...over,
  };
}

const alpha = makeDescriptor({
  provider: "alpha",
  toolDefs: [
    { name: "alpha_read", description: "read", input_schema: { type: "object", properties: {}, required: [] } },
    { name: "alpha_write", description: "write", input_schema: { type: "object", properties: {}, required: [] } },
  ],
  execute: async (name, input) => ({ provider: "alpha", name, input }),
  egress: { alpha_read: { entityType: "alpha_entity" } },
  exposableFields: { alpha_entity: ["id", "status"] },
  handleableFields: { alpha_entity: ["title"] },
});

const beta = makeDescriptor({
  provider: "beta",
  toolDefs: [
    { name: "beta_list", description: "list", input_schema: { type: "object", properties: {}, required: [] } },
  ],
  execute: async (name, input) => ({ provider: "beta", name, input }),
  egress: {}, // empty egress ⇒ no TOOL_ENTITY ⇒ full withhold (the Google case)
});

beforeEach(() => resetConnectors());

describe("connector registry — registration + derived accessors", () => {
  it("aggregates tool defs and names across descriptors", () => {
    registerConnector(alpha);
    registerConnector(beta);

    expect(getConnectorDescriptors().map((d) => d.provider)).toEqual(["alpha", "beta"]);
    expect(connectorToolDefs().map((t) => t.name)).toEqual(["alpha_read", "alpha_write", "beta_list"]);
    expect([...connectorToolNames()].sort()).toEqual(["alpha_read", "alpha_write", "beta_list"]);
  });

  it("routes a call to the OWNING descriptor's executor", async () => {
    registerConnector(alpha);
    registerConnector(beta);

    expect(await executeConnectorTool("alpha_write", { x: 1 }, { orgId: "o", userId: "u" })).toEqual({
      provider: "alpha",
      name: "alpha_write",
      input: { x: 1 },
    });
    expect(await executeConnectorTool("beta_list", {}, { orgId: "o", userId: "u" })).toEqual({
      provider: "beta",
      name: "beta_list",
      input: {},
    });
  });

  it("throws when dispatching a tool no connector owns (caller must gate first)", () => {
    registerConnector(alpha);
    // The guard fires synchronously — it's a programming-error tripwire, reached
    // only if a caller skipped the connectorToolNames() membership check.
    expect(() => executeConnectorTool("not_a_tool", {}, { orgId: "o", userId: "u" })).toThrow(
      /no connector owns tool/,
    );
  });
});

describe("connector registry — egress merge", () => {
  it("merges TOOL_ENTITY / EXPOSABLE_FIELDS / HANDLEABLE_FIELDS; an empty egress map contributes nothing", () => {
    registerConnector(alpha);
    registerConnector(beta);

    const maps = connectorEgressMaps();
    expect(maps.toolEntity).toEqual({ alpha_read: "alpha_entity" });
    expect(maps.exposableFields).toEqual({ alpha_entity: ["id", "status"] });
    expect(maps.handleableFields).toEqual({ alpha_entity: ["title"] });
    // beta contributed no egress entries.
    expect("beta_list" in maps.toolEntity).toBe(false);
  });
});

describe("connector registry — fail-loud collisions", () => {
  it("rejects a DIFFERENT descriptor reusing an existing provider id", () => {
    registerConnector(alpha);
    expect(() => registerConnector(makeDescriptor({ provider: "alpha" }))).toThrow(/provider-id collision/);
  });

  it("is idempotent for the SAME descriptor instance (re-evaluated module is a no-op)", () => {
    registerConnector(alpha);
    expect(() => registerConnector(alpha)).not.toThrow();
    // No duplication: still exactly one alpha, its tools listed once.
    expect(getConnectorDescriptors().filter((d) => d.provider === "alpha")).toHaveLength(1);
    expect(connectorToolDefs().filter((t) => t.name === "alpha_read")).toHaveLength(1);
  });

  it("rejects a duplicate tool name across descriptors", () => {
    registerConnector(alpha);
    const clash = makeDescriptor({
      provider: "gamma",
      toolDefs: [
        { name: "alpha_read", description: "dup", input_schema: { type: "object", properties: {}, required: [] } },
      ],
    });
    expect(() => registerConnector(clash)).toThrow(/duplicate tool names across connectors/);
  });

  it("rejects a duplicate tool name WITHIN one descriptor", () => {
    const dup = makeDescriptor({
      provider: "delta",
      toolDefs: [
        { name: "d_tool", description: "a", input_schema: { type: "object", properties: {}, required: [] } },
        { name: "d_tool", description: "b", input_schema: { type: "object", properties: {}, required: [] } },
      ],
    });
    expect(() => registerConnector(dup)).toThrow(/declares tool "d_tool" twice/);
  });

  it("rejects an egress key that is not one of the descriptor's tools", () => {
    const bad = makeDescriptor({
      provider: "epsilon",
      toolDefs: [
        { name: "e_tool", description: "x", input_schema: { type: "object", properties: {}, required: [] } },
      ],
      egress: { some_other_tool: { entityType: "whatever" } },
    });
    expect(() => registerConnector(bad)).toThrow(/not one of its tools/);
  });

  it("rejects two connectors redefining the same entity's field allowlist with different fields", () => {
    registerConnector(alpha); // exposableFields.alpha_entity = [id, status]
    const conflicting = makeDescriptor({
      provider: "zeta",
      toolDefs: [
        { name: "z_tool", description: "x", input_schema: { type: "object", properties: {}, required: [] } },
      ],
      egress: { z_tool: { entityType: "alpha_entity" } },
      exposableFields: { alpha_entity: ["id", "DIFFERENT"] },
    });
    registerConnector(conflicting);
    expect(() => connectorEgressMaps()).toThrow(/redefines EXPOSABLE_FIELDS/);
  });
});
