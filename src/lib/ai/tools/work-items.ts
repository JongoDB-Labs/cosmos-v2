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
      "List work items in a project with optional filters. Returns id, ticketNumber, title, columnKey, priority, assigneeId, intervalId, dueDate, storyPoints.",
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
  {
    name: "list_item_links",
    description:
      "List work-item dependency links in a project (directed edges typed BLOCKS/PREDECESSOR/RELATES/…). Optionally narrow to links touching one item.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose links to list" },
        itemId: { type: "string", description: "Optional: only links touching this work item" },
        limit: { type: "number", description: "Max results (default 100, cap 200)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "link_items",
    description:
      "Create a directed dependency link between two work items in the SAME project. A work item cannot link to itself.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID both items belong to" },
        fromId: { type: "string", description: "Source work item ID" },
        toId: { type: "string", description: "Target work item ID" },
        type: {
          type: "string",
          enum: ["BLOCKS", "PREDECESSOR", "RELATES", "DUPLICATES"],
          description: "Link type",
        },
      },
      required: ["projectId", "fromId", "toId", "type"],
    },
  },
  {
    name: "unlink_items",
    description: "Remove a work-item dependency link by its link id.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the link belongs to" },
        linkId: { type: "string", description: "Work-item link ID to delete" },
      },
      required: ["projectId", "linkId"],
    },
  },
];
