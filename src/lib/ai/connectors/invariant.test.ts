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
import { JIRA_TOOL_NAMES } from "../executors/jira";
import { SLACK_TOOL_NAMES } from "../executors/slack";
import { M365_TOOL_NAMES } from "../executors/microsoft365";
import { nangoTools } from "../tools/nango";

// The COMMERCIAL-ONLY nango connector was added AFTER this refactor. It contributes
// EMPTY egress (no TOOL_ENTITY) and is excluded from a GOV tenant's tool list, so the
// pre-refactor GOV invariants below are preserved EXACTLY — nango only adds to the
// COMMERCIAL (full-set) surface. These names lock that delta.
const NANGO_TOOL_NAMES = nangoTools.map((t) => t.name);

// The v2.20 NATIVE token-auth connectors (Jira, Slack) are availability:"all" — so,
// like google/github, they are in BOTH the gov AND commercial tool lists, and their
// egress maps merge in. The invariant intentionally INCLUDES them in the gov surface
// (they are gov-usable behind the egress fence; structural-only projection still
// applies — asserted in the projection section below).
const JIRA_TOOL_NAME_LIST = [
  "jira_search_issues",
  "jira_get_issue",
  "jira_list_projects",
  "jira_create_issue",
];
const SLACK_TOOL_NAME_LIST = [
  "slack_list_channels",
  "slack_search_messages",
  "slack_post_message",
];
// The v2.23 NATIVE M365 (Graph, org-app client-credentials) connector is also
// availability:"all" — gov-usable behind the egress fence (GCC-High cloud toggle). It
// joins the gov + commercial tool lists and merges its egress maps in (structural-only
// projection asserted in the projection section below).
const M365_TOOL_NAME_LIST = [
  "m365_list_users",
  "m365_list_messages",
  "m365_list_events",
  "m365_list_drive_items",
];

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
// The GOV tool surface = the pre-refactor google+github list PLUS the v2.20 native
// all-availability connectors (jira, slack) PLUS the v2.23 M365 connector, in
// registration order. Nango (commercial-only) is still EXCLUDED from gov.
const GOV_CONNECTOR_TOOL_NAMES = [
  ...PRE_REFACTOR_GOOGLE_TOOL_NAMES,
  ...PRE_REFACTOR_GITHUB_TOOL_NAMES,
  ...JIRA_TOOL_NAME_LIST,
  ...SLACK_TOOL_NAME_LIST,
  ...M365_TOOL_NAME_LIST,
];

// The connector TOOL_ENTITY / EXPOSABLE / HANDLEABLE maps = github's (google empty)
// PLUS jira's + slack's contributions. jira_create_issue / slack_post_message are
// UNMAPPED on purpose (write results → full withhold floor for gov).
const CONNECTOR_TOOL_ENTITY: Record<string, string> = {
  github_list_issues: "github_issue",
  github_get_issue: "github_issue",
  github_list_pull_requests: "github_pull_request",
  jira_search_issues: "jira_issue",
  jira_get_issue: "jira_issue",
  jira_list_projects: "jira_project",
  slack_search_messages: "slack_message",
  slack_list_channels: "slack_channel",
  m365_list_messages: "m365_message",
  m365_list_events: "m365_event",
  m365_list_drive_items: "m365_drive_item",
  m365_list_users: "m365_user",
};
const CONNECTOR_EXPOSABLE_FIELDS: Record<string, readonly string[]> = {
  github_issue: ["number", "state", "createdAt", "updatedAt", "closedAt"],
  github_pull_request: ["number", "state", "draft", "createdAt", "updatedAt", "closedAt", "mergedAt"],
  jira_issue: ["key", "status", "priority", "issueType", "created", "updated", "resolutiondate", "assigneeAccountId"],
  jira_project: ["id", "key", "projectTypeKey"],
  slack_message: ["ts", "channel", "user", "type"],
  slack_channel: ["id", "is_private", "is_archived", "created"],
  m365_message: ["id", "receivedDateTime", "isRead", "hasAttachments", "importance"],
  m365_event: ["id", "start", "end", "isAllDay", "isCancelled", "showAs"],
  m365_drive_item: ["id", "size", "createdDateTime", "lastModifiedDateTime", "isFolder"],
  m365_user: ["id", "accountEnabled"],
};
// github/google/jira/slack contribute NO handleable fields.
const CONNECTOR_HANDLEABLE_FIELDS: Record<string, readonly string[]> = {};

describe("INVARIANT LOCK — connector tool list (google+github pinned; jira+slack added)", () => {
  it("the executor TOOL_NAMES sets are unchanged (descriptors still reference them)", () => {
    expect([...GOOGLE_TOOL_NAMES].sort()).toEqual([...PRE_REFACTOR_GOOGLE_TOOL_NAMES].sort());
    expect([...GITHUB_TOOL_NAMES].sort()).toEqual([...PRE_REFACTOR_GITHUB_TOOL_NAMES].sort());
    // v2.20 native connectors lock their own name sets.
    expect([...JIRA_TOOL_NAMES].sort()).toEqual([...JIRA_TOOL_NAME_LIST].sort());
    expect([...SLACK_TOOL_NAMES].sort()).toEqual([...SLACK_TOOL_NAME_LIST].sort());
    // v2.23 M365 connector locks its own name set.
    expect([...M365_TOOL_NAMES].sort()).toEqual([...M365_TOOL_NAME_LIST].sort());
  });

  it("a GOV tenant's connectorToolDefs = google+github+jira+slack+m365, in order (nango excluded)", () => {
    // The gov surface is the load-bearing invariant: a gov tenant sees EXACTLY the
    // all-availability connectors' tools, in registration order — and NO nango tool.
    expect(connectorToolDefs("gov").map((t) => t.name)).toEqual(GOV_CONNECTOR_TOOL_NAMES);
  });

  it("the FULL (commercial) connectorToolDefs is the gov list PLUS nango, in order", () => {
    expect(connectorToolDefs().map((t) => t.name)).toEqual([...GOV_CONNECTOR_TOOL_NAMES, ...NANGO_TOOL_NAMES]);
    expect(connectorToolDefs("commercial").map((t) => t.name)).toEqual([...GOV_CONNECTOR_TOOL_NAMES, ...NANGO_TOOL_NAMES]);
  });

  it("connectorToolNames('gov') == google+github+jira+slack+m365 name set (no nango)", () => {
    expect([...connectorToolNames("gov")].sort()).toEqual([...GOV_CONNECTOR_TOOL_NAMES].sort());
  });

  it("every gov connector tool name still matches its owning executor's TOOL_NAMES set (dispatch unchanged)", () => {
    for (const n of PRE_REFACTOR_GOOGLE_TOOL_NAMES) expect(GOOGLE_TOOL_NAMES.has(n)).toBe(true);
    for (const n of PRE_REFACTOR_GITHUB_TOOL_NAMES) expect(GITHUB_TOOL_NAMES.has(n)).toBe(true);
    for (const n of JIRA_TOOL_NAME_LIST) expect(JIRA_TOOL_NAMES.has(n)).toBe(true);
    for (const n of SLACK_TOOL_NAME_LIST) expect(SLACK_TOOL_NAMES.has(n)).toBe(true);
    for (const n of M365_TOOL_NAME_LIST) expect(M365_TOOL_NAMES.has(n)).toBe(true);
    // The gov name set leaks NOTHING beyond google ∪ github ∪ jira ∪ slack ∪ m365 (no nango).
    const govUnion = new Set(GOV_CONNECTOR_TOOL_NAMES);
    for (const n of connectorToolNames("gov")) expect(govUnion.has(n)).toBe(true);
  });
});

describe("INVARIANT LOCK — merged egress maps equal the locked literals", () => {
  it("connectorEgressMaps() deep-equals the github+jira+slack (+empty google) contributions", () => {
    const maps = connectorEgressMaps();
    expect(maps.toolEntity).toEqual(CONNECTOR_TOOL_ENTITY);
    expect(maps.exposableFields).toEqual(CONNECTOR_EXPOSABLE_FIELDS);
    expect(maps.handleableFields).toEqual(CONNECTOR_HANDLEABLE_FIELDS);
  });

  it("entityTypeForTool resolves the connector tools exactly (google + write tools ⇒ undefined ⇒ full withhold)", () => {
    expect(entityTypeForTool("github_list_issues")).toBe("github_issue");
    expect(entityTypeForTool("github_get_issue")).toBe("github_issue");
    expect(entityTypeForTool("github_list_pull_requests")).toBe("github_pull_request");
    expect(entityTypeForTool("jira_search_issues")).toBe("jira_issue");
    expect(entityTypeForTool("jira_get_issue")).toBe("jira_issue");
    expect(entityTypeForTool("jira_list_projects")).toBe("jira_project");
    expect(entityTypeForTool("slack_search_messages")).toBe("slack_message");
    expect(entityTypeForTool("slack_list_channels")).toBe("slack_channel");
    expect(entityTypeForTool("m365_list_messages")).toBe("m365_message");
    expect(entityTypeForTool("m365_list_events")).toBe("m365_event");
    expect(entityTypeForTool("m365_list_drive_items")).toBe("m365_drive_item");
    expect(entityTypeForTool("m365_list_users")).toBe("m365_user");
    // The write tools are UNMAPPED ⇒ full withhold floor for gov.
    expect(entityTypeForTool("jira_create_issue")).toBeUndefined();
    expect(entityTypeForTool("slack_post_message")).toBeUndefined();
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

  it("a gov jira issue is projected to structural-only (key/status/timestamps; summary/description withheld)", () => {
    const issue = {
      key: "ABC-1", status: "In Progress", priority: "High", issueType: "Bug",
      summary: "CUI//SP exfil path", description: "secret repro",
      assigneeAccountId: "acc-1",
      created: "2026-06-01T00:00:00Z", updated: "2026-06-02T00:00:00Z", resolutiondate: null,
    };
    const mv = projectStructural(issue, "jira_issue") as Record<string, unknown>;
    expect(mv).toEqual({
      key: "ABC-1", status: "In Progress", priority: "High", issueType: "Bug",
      assigneeAccountId: "acc-1",
      created: "2026-06-01T00:00:00Z", updated: "2026-06-02T00:00:00Z",
    });
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("secret");
  });

  it("a gov slack message is projected to structural-only (ts/channel/user/type; text withheld)", () => {
    const msg = { ts: "1700000000.000100", channel: "C123", user: "U456", type: "message", text: "CUI//SP exfil" };
    const mv = projectStructural(msg, "slack_message") as Record<string, unknown>;
    expect(mv).toEqual({ ts: "1700000000.000100", channel: "C123", user: "U456", type: "message" });
    expect(JSON.stringify(mv)).not.toContain("text");
    expect(JSON.stringify(mv)).not.toContain("CUI");
  });

  it("a gov m365 message is projected to structural-only (id/flags/timestamp; subject/from withheld)", () => {
    const msg = {
      id: "m1", receivedDateTime: "2026-06-01T12:00:00Z", isRead: false, hasAttachments: true,
      importance: "high", subject: "CUI//SP exfil path", bodyPreview: "secret repro", from: "boss@acme.us",
    };
    const mv = projectStructural(msg, "m365_message") as Record<string, unknown>;
    expect(mv).toEqual({
      id: "m1", receivedDateTime: "2026-06-01T12:00:00Z", isRead: false, hasAttachments: true, importance: "high",
    });
    expect(JSON.stringify(mv)).not.toContain("CUI");
    expect(JSON.stringify(mv)).not.toContain("boss@acme.us");
  });

  it("a gov m365 user is projected to structural-only (id/accountEnabled; displayName/mail withheld)", () => {
    const u = { id: "u1", accountEnabled: true, displayName: "Jane Doe", mail: "jane@acme.us", userPrincipalName: "jane@acme.us" };
    const mv = projectStructural(u, "m365_user") as Record<string, unknown>;
    expect(mv).toEqual({ id: "u1", accountEnabled: true });
    expect(JSON.stringify(mv)).not.toContain("Jane");
    expect(JSON.stringify(mv)).not.toContain("jane@acme.us");
  });
});
