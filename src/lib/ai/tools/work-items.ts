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
      "List work items in a project with optional filters. Returns id, ticketNumber, title, columnKey, priority, assigneeId, assigneeName (the assignee's display name — use it when you name the person, never the id), reporterId and reporterName (who created it; someone who has since left the organization is still named), intervalId, parentId (the item it sits under, or null), teamId (the team that owns it, or null), dueDate, storyPoints. For anything across projects, by date, label, sprint, history or text, use search_work_items when it is available.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID (required)" },
        columnKey: { type: "string", description: "Filter by board column key (e.g. 'todo')" },
        assigneeId: { type: "string", description: "Filter by assignee user ID, or `me` for the caller" },
        createdById: {
          type: "string",
          description:
            "Filter by who CREATED (raised) the item, or `me` for the caller. Different from assigneeId — " +
            "a person often files a ticket they never own.",
        },
        type: {
          type: "string",
          description:
            "Filter by work item type — pass the work item TYPE KEY (e.g. 'software.task') or work-item-type id.",
        },
        search: { type: "string", description: "Case-insensitive title contains" },
        parentId: { type: "string", description: "Only the direct children of this work item (e.g. an epic's id)" },
        teamId: {
          type: "string",
          description:
            "Only this team's work (an id from list_teams): items the team owns, plus unowned items assigned to its members",
        },
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
    name: "list_transitions",
    description:
      "List the status changes (transitions) the user may make on a work item, from its current status, and the fields each one asks for. Use before moving an item when a move is refused, or when the user asks what they can do next.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Work item ID" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "transition_item",
    description:
      "Move a work item through one of its transitions (an id from list_transitions), with the input that transition asks for, keyed `system:<field>` or `custom:<key>`. A refusal says what is missing or which checks failed.",
    input_schema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Work item ID" },
        transitionId: { type: "string", description: "A transition id from list_transitions" },
        input: { type: "object", description: "Values for the fields the transition asks for, e.g. { \"system:resolution\": \"Fixed\" }" },
      },
      required: ["itemId", "transitionId"],
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
