// @vitest-environment node
//
// Verifies the REAL google + github descriptors register cleanly via
// connectors/index.ts and contribute exactly the expected tool defs + egress maps.
// This is the per-descriptor contract check; the cross-system byte-identity lock
// against the pre-refactor literals lives in connectors/invariant.test.ts (Task 4).
import { describe, it, expect } from "vitest";
import {
  connectorToolDefs,
  connectorToolNames,
  connectorEgressMaps,
  getConnectorDescriptors,
} from "./index";
import { googleTools } from "../tools/google";
import { githubTools } from "../tools/github";

describe("real connector descriptors", () => {
  it("registers exactly google + github", () => {
    expect(getConnectorDescriptors().map((d) => d.provider).sort()).toEqual(["github", "google"]);
  });

  it("connectorToolDefs == the google + github tool defs (same names, same schemas)", () => {
    const names = connectorToolDefs().map((t) => t.name);
    const expected = [...googleTools, ...githubTools].map((t) => t.name);
    expect(names.sort()).toEqual(expected.sort());
    // schemas referenced verbatim — identity, not copies.
    const byName = new Map(connectorToolDefs().map((t) => [t.name, t]));
    for (const t of [...googleTools, ...githubTools]) {
      expect(byName.get(t.name)).toBe(t); // same object reference
    }
  });

  it("connectorToolNames covers every google + github tool", () => {
    const names = connectorToolNames();
    for (const t of [...googleTools, ...githubTools]) expect(names.has(t.name)).toBe(true);
  });

  it("google contributes NO egress (full withhold for gov); github maps to structural-only entities", () => {
    const maps = connectorEgressMaps();
    // No google tool has a TOOL_ENTITY mapping.
    for (const t of googleTools) expect(t.name in maps.toolEntity).toBe(false);
    // github tools map to structural-only entity types.
    expect(maps.toolEntity).toMatchObject({
      github_list_issues: "github_issue",
      github_get_issue: "github_issue",
      github_list_pull_requests: "github_pull_request",
    });
    expect(maps.exposableFields.github_issue).toEqual([
      "number", "state", "createdAt", "updatedAt", "closedAt",
    ]);
    expect(maps.exposableFields.github_pull_request).toEqual([
      "number", "state", "draft", "createdAt", "updatedAt", "closedAt", "mergedAt",
    ]);
    // github has NO handleable fields.
    expect("github_issue" in maps.handleableFields).toBe(false);
    expect("github_pull_request" in maps.handleableFields).toBe(false);
  });
});
