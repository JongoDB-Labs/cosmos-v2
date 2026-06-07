// @vitest-environment node
//
// Verifies the REAL google + github + jira + nango descriptors register cleanly via
// connectors/index.ts and contribute exactly the expected tool defs + egress maps.
// This is the per-descriptor contract check; the cross-system byte-identity lock
// against the locked literals lives in connectors/invariant.test.ts.
import { describe, it, expect } from "vitest";
import {
  connectorToolDefs,
  connectorToolNames,
  connectorEgressMaps,
  getConnectorDescriptors,
} from "./index";
import { googleTools } from "../tools/google";
import { githubTools } from "../tools/github";
import { jiraTools } from "../tools/jira";
import { nangoTools } from "../tools/nango";

describe("real connector descriptors", () => {
  it("registers exactly google + github + jira + nango", () => {
    expect(getConnectorDescriptors().map((d) => d.provider).sort()).toEqual([
      "github", "google", "jira", "nango",
    ]);
  });

  it("nango is the only COMMERCIAL-ONLY connector; google + github + jira are 'all'", () => {
    const byProvider = new Map(getConnectorDescriptors().map((d) => [d.provider, d]));
    expect(byProvider.get("nango")?.availability).toBe("commercial-only");
    // google/github omit availability ⇒ default "all"; jira sets it explicitly.
    expect(byProvider.get("google")?.availability ?? "all").toBe("all");
    expect(byProvider.get("github")?.availability ?? "all").toBe("all");
    expect(byProvider.get("jira")?.availability).toBe("all");
  });

  it("connectorToolDefs == the google + github + jira + nango tool defs (same names, same schemas)", () => {
    const names = connectorToolDefs().map((t) => t.name);
    const expected = [...googleTools, ...githubTools, ...jiraTools, ...nangoTools].map((t) => t.name);
    expect(names.sort()).toEqual(expected.sort());
    // schemas referenced verbatim — identity, not copies.
    const byName = new Map(connectorToolDefs().map((t) => [t.name, t]));
    for (const t of [...googleTools, ...githubTools, ...jiraTools, ...nangoTools]) {
      expect(byName.get(t.name)).toBe(t); // same object reference
    }
  });

  it("connectorToolDefs('gov') EXCLUDES every nango tool (D5); jira present; 'commercial' includes nango", () => {
    const govNames = connectorToolDefs("gov").map((t) => t.name);
    for (const t of nangoTools) expect(govNames).not.toContain(t.name);
    // google + github + jira (availability 'all') are present for gov.
    for (const t of [...googleTools, ...githubTools, ...jiraTools]) expect(govNames).toContain(t.name);
    const commNames = connectorToolDefs("commercial").map((t) => t.name);
    for (const t of nangoTools) expect(commNames).toContain(t.name);
  });

  it("connectorToolNames covers every google + github + jira + nango tool", () => {
    const names = connectorToolNames();
    for (const t of [...googleTools, ...githubTools, ...jiraTools, ...nangoTools]) expect(names.has(t.name)).toBe(true);
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

  it("jira maps read tools to structural-only entities; the write tool is unmapped", () => {
    const maps = connectorEgressMaps();
    expect(maps.toolEntity).toMatchObject({
      jira_search_issues: "jira_issue",
      jira_get_issue: "jira_issue",
      jira_list_projects: "jira_project",
    });
    // jira_create_issue (the write) is deliberately unmapped ⇒ full withhold for gov.
    expect("jira_create_issue" in maps.toolEntity).toBe(false);
    expect(maps.exposableFields.jira_issue).toEqual([
      "key", "status", "priority", "issueType", "created", "updated", "resolutiondate", "assigneeAccountId",
    ]);
    expect(maps.exposableFields.jira_project).toEqual(["id", "key", "projectTypeKey"]);
    expect("jira_issue" in maps.handleableFields).toBe(false);
  });

  it("nango contributes NO egress mapping (commercial-only; gov is blocked, commercial flows full below FOUO)", () => {
    const maps = connectorEgressMaps();
    // No nango tool maps to a TOOL_ENTITY (deliberately empty egress).
    for (const t of nangoTools) expect(t.name in maps.toolEntity).toBe(false);
  });
});
