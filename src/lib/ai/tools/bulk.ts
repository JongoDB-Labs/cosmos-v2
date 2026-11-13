import type { ToolDefinition } from "../tools";

/**
 * Bulk changes to work items. Mirrors `PUT /projects/:projectId/work-items/bulk`,
 * per project, with every row also held to the single-item edit gate.
 */
/** The most items one bulk call may change. A larger selection is refused whole. */
export const BULK_TOOL_MAX = 100;

export const bulkTools: ToolDefinition[] = [
  {
    name: "bulk_update_work_items",
    confirm: true,
    description:
      `Apply ONE change to many work items at once (at most ${BULK_TOOL_MAX}): move them to a status, assign or unassign them, set their priority, put them in a sprint (or take them out), or add/remove labels. ` +
      "Choose the items with `cql` (the same query search_work_items takes) or with `ids`. " +
      "The first call changes nothing: it returns a preview (how many items, which ids, the change) and a confirmationToken. Tell the user how many items and exactly what will change, and wait for their yes; then call again with the same arguments plus the token. " +
      "Items you may not edit, or that the workflow refuses, are skipped and listed with the reason; the rest change.",
    input_schema: {
      type: "object",
      properties: {
        cql: { type: "string", description: "Query choosing the items, e.g. `project = ACME AND status = \"To Do\" AND assignee = currentUser()`" },
        ids: { type: "array", items: { type: "string" }, description: "Work item ids, instead of cql" },
        status: { type: "string", description: "Status key or name to move them to, e.g. in_progress or \"In Review\"" },
        assigneeId: { type: "string", description: "userId to assign, \"me\", or \"none\" to unassign" },
        priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
        intervalId: { type: "string", description: "Sprint (interval) id to put them in (list_intervals), or \"none\" to take them out of their sprint" },
        addLabels: { type: "array", items: { type: "string" } },
        removeLabels: { type: "array", items: { type: "string" } },
      },
      required: [],
    },
  },
];
