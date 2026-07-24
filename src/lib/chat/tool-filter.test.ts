import { describe, expect, it } from "vitest";
import { filterToolsByScope } from "./tool-filter";
import type { ToolDefinition } from "@/lib/ai/tools";

// A representative slice of the real cosmos tool catalog: read tools, the
// explicit read-only tools, and a spread of mutation tools (create/update/
// delete/log/send/add/process). Built inline so the unit test stays hermetic
// and doesn't pull in the heavy server-side tool modules (googleapis, etc.).
function tool(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: "object", properties: {}, required: [] } };
}

const READ_TOOLS = [
  "query_work_items",
  "query_intervals",
  "query_crm",
  "query_finance",
  "query_compliance_controls",
  "list_work_items",
  "list_projects",
  "list_intervals",
  "list_comments",
  "list_time_entries",
  "list_org_members",
  "list_calendar_events",
  "list_drive_files",
  "get_finance_summary",
  "get_profit_and_loss",
  "get_trial_balance",
  "search_contacts",
  "search_emails",
  "read_email",
  "read_google_doc",
  "semantic_search",
  "generate_interval_brief",
  "fetch_url",
];

const MUTATION_TOOLS = [
  "create_work_item",
  "update_work_item",
  "delete_work_item",
  "create_interval",
  "create_note",
  "update_note",
  "delete_note",
  "add_comment",
  "delete_comment",
  "log_time",
  "log_revenue",
  "log_expense",
  "send_email",
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
  "create_drive_folder",
  "update_compliance_control",
  "process_transcript",
];

const ALL = [...READ_TOOLS, ...MUTATION_TOOLS].map(tool);

describe("filterToolsByScope", () => {
  it("NONE returns no tools", () => {
    expect(filterToolsByScope("NONE", ALL)).toEqual([]);
  });

  it("FULL returns every tool unchanged", () => {
    const out = filterToolsByScope("FULL", ALL);
    expect(out).toHaveLength(ALL.length);
    expect(out.map((t) => t.name).sort()).toEqual(ALL.map((t) => t.name).sort());
  });

  it("READONLY keeps exactly the read tools", () => {
    const out = filterToolsByScope("READONLY", ALL).map((t) => t.name);
    expect(out.sort()).toEqual([...READ_TOOLS].sort());
  });

  it("READONLY excludes every create/update/delete/log/send mutation tool", () => {
    const out = new Set(filterToolsByScope("READONLY", ALL).map((t) => t.name));
    for (const name of MUTATION_TOOLS) {
      expect(out.has(name), `READONLY must exclude mutation tool ${name}`).toBe(false);
    }
    // Spot-check the load-bearing privilege-escalation cases explicitly.
    expect(out.has("create_work_item")).toBe(false);
    expect(out.has("update_work_item")).toBe(false);
    expect(out.has("delete_work_item")).toBe(false);
    expect(out.has("log_expense")).toBe(false);
    expect(out.has("send_email")).toBe(false);
  });

  it("READONLY keeps the explicitly-allowed read tools without a read prefix", () => {
    const out = new Set(filterToolsByScope("READONLY", ALL).map((t) => t.name));
    expect(out.has("semantic_search")).toBe(true);
    expect(out.has("generate_interval_brief")).toBe(true);
    expect(out.has("fetch_url")).toBe(true);
  });

  it("does not mutate the input array", () => {
    const input = [...ALL];
    filterToolsByScope("READONLY", input);
    expect(input).toHaveLength(ALL.length);
  });
});
