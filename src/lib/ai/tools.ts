import { connectorToolDefs } from "./connectors";
import { workItemTools } from "./tools/work-items";
import { noteTools } from "./tools/notes";
import { commentTools } from "./tools/comments";
import { timeTools } from "./tools/time";
import { financeTools } from "./tools/finance";
import { accountingTools } from "./tools/accounting";
import { projectTools } from "./tools/projects";
import { utilityTools } from "./tools/utility";
import { ragTools } from "./tools/rag";
import { complianceTools } from "./tools/compliance";

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * JSON Schema describing the tool's parameters.
   * Named `input_schema` to mirror Anthropic's native tool_use shape — the
   * Claude CLI text protocol does not care about the field name, but other
   * callers (and our `formatToolsForSystemPrompt` helper) expect this key.
   */
  input_schema: Record<string, unknown>;
}

/**
 * Render the cosmos tool catalog into the text block that gets concatenated
 * onto the system prompt for `claude -p` subprocess invocations. The model
 * is instructed elsewhere to emit `TOOL_CALL: {"name":..., "arguments":...}`
 * for any call it wants to make.
 */
export function formatToolsForSystemPrompt(tools: ToolDefinition[]): string {
  return tools
    .map(
      (t) =>
        `Tool: ${t.name} — ${t.description}\nParameters: ${JSON.stringify(t.input_schema)}`
    )
    .join("\n\n");
}

export const cosmosTools: ToolDefinition[] = [
  {
    name: "query_work_items",
    description: "Search and filter work items in the project. Returns matching items with their status, assignee, priority, and cycle.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID to search in" },
        query: { type: "string", description: "Text search query for title/description" },
        status: { type: "string", description: "Column category filter: TODO, IN_PROGRESS, DONE, CANCELLED" },
        assigneeId: { type: "string", description: "Filter by assignee user ID" },
        priority: { type: "string", description: "Filter by priority: CRITICAL, HIGH, MEDIUM, LOW" },
        cycleId: { type: "string", description: "Filter by cycle ID" },
        workItemTypeId: { type: "string", description: "Filter by work item type ID" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "create_work_item",
    description:
      "Create a new work item. Pass `type` (e.g. 'task', 'story', 'bug', 'epic' — sector-aware lookup) OR a specific `workItemTypeId`. `columnKey` defaults to 'todo'.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        title: { type: "string", description: "Title of the work item" },
        type: {
          type: "string",
          description:
            "Short type name (task/story/bug/epic) or a full key like 'software.task'. Resolved against the project's template sector.",
        },
        workItemTypeId: { type: "string", description: "Specific WorkItemType id (alternative to `type`)" },
        columnKey: { type: "string", description: "Board column key (default 'todo')" },
        description: { type: "string" },
        priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
        assigneeId: { type: "string", description: "Assignee user ID" },
        cycleId: { type: "string", description: "Cycle ID to assign to" },
        parentId: { type: "string", description: "Parent work item ID for subtasks" },
        storyPoints: { type: "number", description: "Story points estimate" },
      },
      required: ["projectId", "title"],
    },
  },
  {
    name: "update_work_item",
    description: "Update an existing work item's fields.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Work item ID to update" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
        assigneeId: { type: "string" },
        cycleId: { type: "string" },
        columnKey: { type: "string", description: "Move to a different column" },
        storyPoints: { type: "number" },
        parentId: { type: "string" },
        dueDate: { type: "string", description: "ISO datetime" },
        startDate: { type: "string", description: "ISO datetime" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["itemId"],
    },
  },
  {
    name: "query_cycles",
    description: "Get cycle/sprint information including velocity, item counts, and burndown data.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        status: { type: "string", enum: ["PLANNED", "ACTIVE", "COMPLETED"], description: "Cycle status filter" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "query_crm",
    description: "Search CRM contacts and pipeline deals.",
    input_schema: {
      type: "object",
      properties: {
        stage: { type: "string", description: "Filter by pipeline stage" },
        query: { type: "string", description: "Search by name" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "query_finance",
    description: "Get financial data including revenue, expenses, and time tracking summaries.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date (ISO format)" },
        endDate: { type: "string", description: "End date (ISO format)" },
      },
      required: [],
    },
  },
  {
    name: "generate_cycle_brief",
    description: "Generate a comprehensive cycle/sprint status brief with velocity, burndown, blockers, and team workload.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        cycleId: { type: "string", description: "Cycle ID (defaults to active cycle)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "process_transcript",
    description: "Extract action items, decisions, and follow-ups from a meeting transcript.",
    input_schema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "The meeting transcript text" },
        meetingId: { type: "string", description: "Meeting ID to associate extracted items with" },
      },
      required: ["transcript"],
    },
  },
  // Phase 3b: cosmos-internal CRUD tools — split by domain so each domain
  // file owns its definitions + executor pair.
  ...workItemTools,
  ...noteTools,
  ...commentTools,
  ...timeTools,
  ...financeTools,
  ...accountingTools,
  ...projectTools,
  ...utilityTools,
  // Phase 5c: semantic search across notes/work items/contracts/meetings.
  ...ragTools,
  // Compliance: run control checks, drive remediation, resolve members to assign/notify.
  ...complianceTools,
  // EXTERNAL connectors (Google Workspace, GitHub, …) are no longer hand-listed
  // here — they come from the declarative connector registry (connectors/index.ts),
  // so adding a connector is one descriptor + one registration, with no edit to this
  // file. The registry returns the same tool defs in the same order (google then
  // github) as the prior explicit spread; the agent loop is order-insensitive anyway.
  ...connectorToolDefs(),
];

// Re-export the native sub-catalogs for callers who want them directly.
export {
  workItemTools,
  noteTools,
  commentTools,
  timeTools,
  financeTools,
  accountingTools,
  projectTools,
  utilityTools,
  ragTools,
  complianceTools,
};
