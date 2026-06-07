// @vitest-environment node
//
// Verifies the REAL google + github + nango descriptors register cleanly via
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
import { nangoTools } from "../tools/nango";

describe("real connector descriptors", () => {
  it("registers exactly google + github + nango", () => {
    expect(getConnectorDescriptors().map((d) => d.provider).sort()).toEqual(["github", "google", "nango"]);
  });

  it("nango is the only COMMERCIAL-ONLY connector; google + github are 'all'", () => {
    const byProvider = new Map(getConnectorDescriptors().map((d) => [d.provider, d]));
    expect(byProvider.get("nango")?.availability).toBe("commercial-only");
    // google/github omit availability ⇒ default "all".
    expect(byProvider.get("google")?.availability ?? "all").toBe("all");
    expect(byProvider.get("github")?.availability ?? "all").toBe("all");
  });

  it("connectorToolDefs == the google + github + nango tool defs (same names, same schemas)", () => {
    const names = connectorToolDefs().map((t) => t.name);
    const expected = [...googleTools, ...githubTools, ...nangoTools].map((t) => t.name);
    expect(names.sort()).toEqual(expected.sort());
    // schemas referenced verbatim — identity, not copies.
    const byName = new Map(connectorToolDefs().map((t) => [t.name, t]));
    for (const t of [...googleTools, ...githubTools, ...nangoTools]) {
      expect(byName.get(t.name)).toBe(t); // same object reference
    }
  });

  it("connectorToolDefs('gov') EXCLUDES every nango tool (D5); 'commercial' includes them", () => {
    const govNames = connectorToolDefs("gov").map((t) => t.name);
    for (const t of nangoTools) expect(govNames).not.toContain(t.name);
    // google + github (availability 'all') are still present for gov.
    for (const t of [...googleTools, ...githubTools]) expect(govNames).toContain(t.name);
    const commNames = connectorToolDefs("commercial").map((t) => t.name);
    for (const t of nangoTools) expect(commNames).toContain(t.name);
  });

  it("connectorToolNames covers every google + github + nango tool", () => {
    const names = connectorToolNames();
    for (const t of [...googleTools, ...githubTools, ...nangoTools]) expect(names.has(t.name)).toBe(true);
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

  it("nango contributes NO egress mapping (commercial-only; gov is blocked, commercial flows full below FOUO)", () => {
    const maps = connectorEgressMaps();
    // No nango tool maps to a TOOL_ENTITY (deliberately empty egress).
    for (const t of nangoTools) expect(t.name in maps.toolEntity).toBe(false);
  });
});
