import type { ToolDefinition } from "../tools";

/**
 * Saved filters (query design §10): named CQL queries a person keeps, and may
 * share with a team, a project or the whole organization. The assistant reads
 * and writes them through the SAME functions as the saved-views API, so it can
 * do nothing with a filter the user couldn't in the app.
 */
const VISIBILITIES = ["PRIVATE", "TEAM", "PROJECT", "ORG"];

export const savedViewTools: ToolDefinition[] = [
  {
    name: "list_saved_views",
    description:
      "List the saved filters (saved views) the user can see: their own, ones they co-edit, and ones shared with a team, project or the whole organization. " +
      "Pass projectId for only the filters shared with that project. Each has its visibility, owner, whether the user can edit or delete it, " +
      "and a url that opens it in Cosmos (give it to the user). A filter's query is not listed: to search with it, open the url.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Only the filters shared with this project" },
      },
    },
  },
  {
    name: "create_saved_view",
    description:
      "Save a CQL query as a named filter the user owns (see search_work_items for CQL). It is always saved private. " +
      "To share it with a team, a project or the whole organization, call share_saved_view next, which asks the user first. " +
      "On invalid CQL returns diagnostics with line and column: fix the query and retry. Names are unique per owner.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The filter's name (max 80 characters)" },
        cql: { type: "string", description: "The CQL query to save" },
        description: { type: "string", description: "Optional description (max 500 characters)" },
      },
      required: ["name", "cql"],
    },
  },
  {
    name: "update_saved_view",
    description:
      "Rename a saved filter, change its description, or replace its CQL query. Its owner, its co-editors and administrators can. " +
      "A filter that refers to things the user can't see can't be overwritten: save a new one instead. To change who sees it, use share_saved_view.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "The saved filter's id (from list_saved_views)" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        cql: { type: "string", description: "New CQL query" },
      },
      required: ["viewId"],
    },
  },
  {
    name: "share_saved_view",
    confirm: true,
    description:
      "Change who sees a saved filter: PRIVATE (only its owner and co-editors), TEAM (needs teamId), PROJECT (needs projectId) or ORG (everyone; needs the Share filters with the org permission). " +
      "Only the filter's owner or an administrator can. Confirm with the user first.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "The saved filter's id (from list_saved_views)" },
        visibility: { type: "string", enum: VISIBILITIES, description: "Who sees it" },
        projectId: { type: "string", description: "The project to share it with, for PROJECT" },
        teamId: { type: "string", description: "The team to share it with, for TEAM" },
      },
      required: ["viewId", "visibility"],
    },
  },
  {
    name: "delete_saved_view",
    confirm: true,
    description: "Delete a saved filter. Only its owner or an administrator can.",
    input_schema: {
      type: "object",
      properties: {
        viewId: { type: "string", description: "The saved filter's id (from list_saved_views)" },
      },
      required: ["viewId"],
    },
  },
];
