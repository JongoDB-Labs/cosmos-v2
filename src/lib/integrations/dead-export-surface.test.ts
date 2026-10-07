// @vitest-environment node
//
// CLEANUP-14 removed four unreachable surfaces from src/lib/integrations. An export
// with no importer reads as a supported API — the next person wires a feature to it
// and inherits code nothing has ever exercised. These tests pin the module surfaces
// so a deleted entry point cannot quietly reappear, and assert the LIVE neighbours
// that must survive alongside it.
import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import * as mcpSecrets from "./mcp-secrets";
import * as graph from "./microsoft-graph";
import { IntegrationRegistry } from "./registry";

describe("mcp-secrets surface", () => {
  it("exports the seal + the two accessors, and no third unseal wrapper", () => {
    expect(Object.keys(mcpSecrets).sort()).toEqual([
      "getMcpEnv",
      "getMcpHeaders",
      "sealMcpJson",
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

describe("webhook-dispatch", () => {
  it("is gone — the webhooks test route owns the one live seal-open + HMAC sender", () => {
    const path = fileURLToPath(new URL("./webhook-dispatch.ts", import.meta.url));
    expect(existsSync(path)).toBe(false);
  });
});
