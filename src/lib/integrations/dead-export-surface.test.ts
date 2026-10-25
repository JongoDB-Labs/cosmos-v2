// @vitest-environment node
//
// CLEANUP-14 removed unreachable surfaces from src/lib/integrations. An export
// with no importer reads as a supported API — the next person wires a feature to it
// and inherits code nothing has ever exercised. These tests pin the module surfaces
// so a deleted entry point cannot quietly reappear, and assert the LIVE neighbours
// that must survive alongside it.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import * as mcpSecrets from "./mcp-secrets";
import * as graph from "./microsoft-graph";
import { IntegrationRegistry } from "./registry";

describe("mcp-secrets surface", () => {
  it("exports the seal, the two accessors, and the unseal a composed plugin uses", () => {
    // unsealMcpJson has no importer in core; the Foreman plugin imports it.
    expect(Object.keys(mcpSecrets).sort()).toEqual([
      "getMcpEnv",
      "getMcpHeaders",
      "sealMcpJson",
      "unsealMcpJson",
    ]);
  });
});

describe("microsoft-graph surface", () => {
  const keys = Object.keys(graph);

  it("keeps the live Graph helpers", () => {
    expect(keys).toEqual(
      expect.arrayContaining(["endpointsFor", "getGraphToken", "graphFetch", "graphUploadFile"]),
    );
  });

  it("does not export an unused download half", () => {
    expect(keys).not.toContain("graphDownloadFile");
  });
});

describe("IntegrationRegistry surface", () => {
  it("exposes exactly register/get/getAll — category grouping lives in filter.ts", () => {
    expect(Object.keys(IntegrationRegistry).sort()).toEqual(["get", "getAll", "register"]);
  });
});
