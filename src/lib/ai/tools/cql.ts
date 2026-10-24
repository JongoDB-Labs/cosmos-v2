import type { ToolDefinition } from "../tools";
import { fieldNames } from "@/lib/query/describe";

/**
 * Query-language tools (query design §12.3): search across every readable
 * project with CQL, and look up the language and one field's values instead of
 * guessing them. Only for orgs with the query language switched on; elsewhere
 * they say so and point at `list_work_items`.
 */
/** The optional item fields `search_work_items` can return. */
export const SEARCH_FIELDS = ["title", "status", "assignee", "priority", "due", "sprint", "points", "labels"] as const;

export const cqlTools: ToolDefinition[] = [
  {
    name: "search_work_items",
    description:
      "Search work items across every project the user can read, using CQL (Cosmos Query Language, like Jira's JQL). " +
      "Examples: `assignee = me AND statusCategory != DONE ORDER BY due`, `sprint IN openSprints() AND blocked = true`, " +
      "`status CHANGED TO Done AFTER -7d`, `project = ACME AND priority IN (HIGH, CRITICAL) AND due < now()`. " +
      `Fields: ${fieldNames()}. Call describe_cql for the operators, functions and a field's values. ` +
      "Returns count, total, the normalized cql, a url to open the results in Cosmos (give it to the user), and the items. " +
      "On invalid CQL returns diagnostics with line and column: fix the query and retry.",
    input_schema: {
      type: "object",
      properties: {
        cql: { type: "string", description: "The CQL query" },
        limit: { type: "number", description: "Max items returned (default 25, cap 50); total still counts every match" },
        fields: {
          type: "array",
          items: { type: "string", enum: [...SEARCH_FIELDS] },
          description: "Which item fields to return beyond ids and dates (default all of them)",
        },
      },
      required: ["cql"],
    },
  },
  {
    name: "describe_cql",
    description:
      "Describe CQL. With no field: the syntax, every field with its operators, every function, this org's custom fields and examples. " +
      "With a field: the values it can take here, each with the exact text to write in a query (e.g. the statuses, sprints or people), optionally narrowed by a prefix.",
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", description: "A field name such as status, sprint, assignee, label, or a custom field key" },
        prefix: { type: "string", description: "Only values starting with this" },
      },
    },
  },
];
