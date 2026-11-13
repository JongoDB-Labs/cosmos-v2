import type { ToolDefinition } from "../tools";
import { BOARD_TYPE_ORDER, BOARD_TYPE_REGISTRY, savableFromViewTypes } from "@/lib/boards/board-types";

/**
 * Board tools. Mirror `api/v1/orgs/[orgId]/projects/[projectId]/boards` and its
 * children; the writes go through the same board service as those routes.
 *
 * The type lists come from the board type registry, never a copy of it: a type
 * added there is offered here, and "which types can show a query" is the
 * registry's `savableFromView`, the same flag the Save-as-board dialog reads.
 */
const BOARD_TYPES: string[] = [...BOARD_TYPE_ORDER];
const QUERY_TYPES = savableFromViewTypes().map((t) => BOARD_TYPE_REGISTRY[t].label).join(", ");

const boardRef = {
  projectId: { type: "string", description: "Project ID the board belongs to" },
  boardId: { type: "string", description: "Board ID (from list_boards)" },
};

export const boardTools: ToolDefinition[] = [
  {
    name: "list_boards",
    description: "List a project's boards (name, type, sort order).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose boards to list" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "get_board",
    description:
      "Get one board: its type, its columns, its link, and its baseline query (the CQL that decides which items it shows; null when it shows the whole project).",
    input_schema: {
      type: "object",
      properties: boardRef,
      required: ["projectId", "boardId"],
    },
  },
  {
    name: "create_board",
    description:
      "Create a board in a project, the same as 'Save as board' in the app. Give `cql` to make a board that shows only the items a query matches (a project clause is dropped: the board is pinned to its own project). " +
      `Only these board types can show a query: ${QUERY_TYPES}. ` +
      "Without `cql` the board shows every item in the project. Returns the new board's link.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project to create the board in" },
        name: { type: "string", description: "Board name (1-100 characters)" },
        type: { type: "string", enum: BOARD_TYPES, description: "Board type. Default KANBAN." },
        cql: { type: "string", description: "Optional CQL query for the board's baseline, e.g. `assignee = currentUser() AND status != Done`" },
      },
      required: ["projectId", "name"],
    },
  },
  {
    name: "update_board",
    description:
      "Rename a board, or change its baseline query. `cql` replaces the query; an empty string removes it so the board shows the whole project again. Other board settings are kept.",
    input_schema: {
      type: "object",
      properties: {
        ...boardRef,
        name: { type: "string", description: "New name" },
        cql: { type: "string", description: "New baseline query, or \"\" to remove it" },
      },
      required: ["projectId", "boardId"],
    },
  },
  {
    name: "set_board_columns",
    description:
      "Replace a board's columns with this list, in order. A column whose key the board already has is kept and edited; a new key adds a column (and its status, on delivery boards); a column left out is removed from the board, but its status and items stay. Read the board with get_board first and send every column you want kept.",
    input_schema: {
      type: "object",
      properties: {
        ...boardRef,
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Existing column id, to change that column's key" },
              name: { type: "string" },
              key: { type: "string", description: "Status key the column shows, e.g. in_review" },
              color: { type: "string", description: "Hex colour like #7dd3fc" },
              wipLimit: { type: "integer", description: "Work-in-progress limit; leave out for none" },
              category: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"], description: "Category of a NEW status" },
            },
            required: ["name", "key"],
          },
        },
      },
      required: ["projectId", "boardId", "columns"],
    },
  },
  {
    name: "delete_board",
    confirm: true,
    description:
      "Delete a board. Boards cannot be archived; deleting removes only the board, never its work items. Confirm with the user first.",
    input_schema: {
      type: "object",
      properties: boardRef,
      required: ["projectId", "boardId"],
    },
  },
];
