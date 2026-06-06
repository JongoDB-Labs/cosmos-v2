import type { ToolDefinition } from "../tools";

/**
 * Mutation + listing tools for work items. Reads are also covered by the
 * legacy `query_work_items` tool in `tools.ts`; `list_work_items` is the
 * mutation-friendlier name and ships the same filters.
 */
export const workItemTools: ToolDefinition[] = [
  {
    name: "list_work_items",
    description:
      "List work items in a project with optional filters. Returns id, ticketNumber, title, columnKey, priority, assigneeId, cycleId, dueDate, storyPoints.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (required)" },
        columnKey: { type: "string", description: "Filter by board column key (e.g. 'todo')" },
        assigneeId: { type: "string", description: "Filter by assignee user ID" },
        type: {
          type: "string",
          description:
            "Filter by work item type — pass the work item TYPE KEY (e.g. 'software.task') or work-item-type id.",
        },
        search: { type: "string", description: "Case-insensitive title contains" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "delete_work_item",
    description:
      "Delete a work item by id. Cascades to its activities + comments. Requires ITEM_DELETE.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Work item id to delete" },
      },
      required: ["itemId"],
    },
  },
];
