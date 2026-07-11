import type { ToolDefinition } from "../tools";

/**
 * Board tools — read-only listing of a project's boards. Mirrors
 * `api/v1/orgs/[orgId]/projects/[projectId]/boards` (GET).
 */
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
];
