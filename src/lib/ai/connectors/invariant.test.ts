// @vitest-environment node
//
// INVARIANT LOCK — the behavior-preserving backstop for the connector-registry
// refactor. It pins the registry-derived tool list + the merged egress maps to the
// EXACT pre-refactor literal values (captured below from the v2.9.0 wiring before
// this refactor: tools.ts's explicit `...googleTools, ...githubTools` spread, the
// GOOGLE_TOOL_NAMES/GITHUB_TOOL_NAMES executor sets, and projection.ts's github
// TOOL_ENTITY + EXPOSABLE_FIELDS entries).
//
// If this test ever fails, the refactor changed an external connector's effective
// behavior — its presence in the model tool list, its dispatch routing, or (most
// importantly) its EGRESS mapping (what a gov tenant's model is allowed to see). Fix
// the REFACTOR, never relax these expectations.
import { describe, it, expect } from "vitest";
import { connectorToolDefs, connectorToolNames, connectorEgressMaps } from "./index";
import { entityTypeForTool, projectStructural } from "../egress/projection";
import { GOOGLE_TOOL_NAMES } from "../executors/google";
import { GITHUB_TOOL_NAMES } from "../executors/github";

// ── PRE-REFACTOR LITERALS (the v2.9.0 ground truth) ────────────────────────────

// The connector tools, in the order tools.ts spread them (google then github).
const PRE_REFACTOR_GOOGLE_TOOL_NAMES = [
  "send_email",
  "search_emails",
  "read_email",
  "list_calendar_events",
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
  "list_drive_files",
  "read_google_doc",
  "create_drive_folder",
  "search_contacts",
];
const PRE_REFACTOR_GITHUB_TOOL_NAMES = [
  "github_list_issues",
  "github_get_issue",
  "github_list_pull_requests",
];
const PRE_REFACTOR_CONNECTOR_TOOL_NAMES = [
  ...PRE_REFACTOR_GOOGLE_TOOL_NAMES,
  ...PRE_REFACTOR_GITHUB_TOOL_NAMES,
];

// The github egress entries that lived in projection.ts pre-refactor. Google had
// NONE (full withhold for gov) — so the connector TOOL_ENTITY/EXPOSABLE/HANDLEABLE
// contributions are EXACTLY github's.
const PRE_REFACTOR_CONNECTOR_TOOL_ENTITY: Record<string, string> = {
  github_list_issues: "github_issue",
  github_get_issue: "github_issue",
  github_list_pull_requests: "github_pull_request",
};
const PRE_REFACTOR_CONNECTOR_EXPOSABLE_FIELDS: Record<string, readonly string[]> = {
  github_issue: ["number", "state", "createdAt", "updatedAt", "closedAt"],
  github_pull_request: ["number", "state", "draft", "createdAt", "updatedAt", "closedAt", "mergedAt"],
};
// github (and google) contributed NO handleable fields pre-refactor.
const PRE_REFACTOR_CONNECTOR_HANDLEABLE_FIELDS: Record<string, readonly string[]> = {};

describe("INVARIANT LOCK — connector tool list is byte-identical to pre-refactor", () => {
  it("the executor TOOL_NAMES sets are unchanged (descriptors still reference them)", () => {
    expect([...GOOGLE_TOOL_NAMES].sort()).toEqual([...PRE_REFACTOR_GOOGLE_TOOL_NAMES].sort());
    expect([...GITHUB_TOOL_NAMES].sort()).toEqual([...PRE_REFACTOR_GITHUB_TOOL_NAMES].sort());
  });

  it("connectorToolDefs() yields exactly the pre-refactor connector tools, in order", () => {
    expect(connectorToolDefs().map((t) => t.name)).toEqual(PRE_REFACTOR_CONNECTOR_TOOL_NAMES);
  });

  it("connectorToolNames() == the pre-refactor connector tool-name set", () => {
    expect([...connectorToolNames()].sort()).toEqual([...PRE_REFACTOR_CONNECTOR_TOOL_NAMES].sort());
  });

  it("every connector tool name matches its owning executor's TOOL_NAMES set (dispatch unchanged)", () => {
    const names = connectorToolNames();
    for (const n of PRE_REFACTOR_GOOGLE_TOOL_NAMES) expect(GOOGLE_TOOL_NAMES.has(n)).toBe(true);
    for (const n of PRE_REFACTOR_GITHUB_TOOL_NAMES) expect(GITHUB_TOOL_NAMES.has(n)).toBe(true);
    // no extra connector tool leaked in beyond google ∪ github.
    const union = new Set([...PRE_REFACTOR_GOOGLE_TOOL_NAMES, ...PRE_REFACTOR_GITHUB_TOOL_NAMES]);
    for (const n of names) expect(union.has(n)).toBe(true);
  });
});

describe("INVARIANT LOCK — merged egress maps equal the pre-refactor literals", () => {
  it("connectorEgressMaps() deep-equals the pre-refactor github (+empty google) contributions", () => {
    const maps = connectorEgressMaps();
    expect(maps.toolEntity).toEqual(PRE_REFACTOR_CONNECTOR_TOOL_ENTITY);
    expect(maps.exposableFields).toEqual(PRE_REFACTOR_CONNECTOR_EXPOSABLE_FIELDS);
    expect(maps.handleableFields).toEqual(PRE_REFACTOR_CONNECTOR_HANDLEABLE_FIELDS);
  });

  it("entityTypeForTool resolves the connector tools exactly as before (google ⇒ undefined ⇒ full withhold)", () => {
    expect(entityTypeForTool("github_list_issues")).toBe("github_issue");
    expect(entityTypeForTool("github_get_issue")).toBe("github_issue");
    expect(entityTypeForTool("github_list_pull_requests")).toBe("github_pull_request");
    // Every google tool stays unmapped ⇒ full withhold for gov.
    for (const n of PRE_REFACTOR_GOOGLE_TOOL_NAMES) expect(entityTypeForTool(n)).toBeUndefined();
  });

  it("a gov github issue is STILL projected to structural-only (number/state/timestamps; title/body withheld)", () => {
    const issue = {
      number: 42, state: "open",
      title: "CUI//SP exfil path", body: "secret repro", labels: ["bug"],
      createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z", closedAt: null,
    };
    const mv = projectStructural(issue, "github_issue") as Record<string, unknown>;
    expect(mv).toEqual({
      number: 42, state: "open",
      createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z",
    });
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("secret");
  });
});
