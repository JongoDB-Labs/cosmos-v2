import type { ToolDefinition } from "../tools";

/**
 * Document tools — read-only listing of a project's ingested documents. Mirrors
 * `api/v1/orgs/[orgId]/projects/[projectId]/documents` (GET).
 */
export const documentTools: ToolDefinition[] = [
  {
    name: "list_documents",
    description:
      "List a project's documents (content type, format, parse status, size, page count, classification).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose documents to list" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: ["projectId"],
    },
  },
];
