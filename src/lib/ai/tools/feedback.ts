import type { ToolDefinition } from "../tools";

/**
 * Feedback tools — the org's bug/feature backlog (FeedbackItem). Mirrors
 * `api/v1/orgs/[orgId]/feedback/…`. The author of a created item is the actor.
 */
export const feedbackTools: ToolDefinition[] = [
  {
    name: "list_feedback",
    description:
      "List the org's feedback items (bugs and feature requests), most-voted first. Optionally filter by type or status.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["BUG", "FEATURE"], description: "Optional type filter" },
        status: {
          type: "string",
          enum: ["OPEN", "PLANNED", "IN_PROGRESS", "DONE", "DECLINED"],
          description: "Optional status filter",
        },
        limit: { type: "number", description: "Max results (default 50, cap 200)" },
      },
      required: [],
    },
  },
  {
    name: "create_feedback",
    description: "Submit a feedback item (bug or feature request). The current user is recorded as the author.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["BUG", "FEATURE"], description: "Feedback type (default FEATURE)" },
        title: { type: "string", description: "Short title (max 200 chars)" },
        description: { type: "string", description: "Optional detail (max 5000 chars)" },
      },
      required: ["title"],
    },
  },
  {
    name: "set_feedback_status",
    description: "Triage a feedback item by setting its status.",
    input_schema: {
      type: "object",
      properties: {
        feedbackId: { type: "string", description: "Feedback item ID" },
        status: {
          type: "string",
          enum: ["OPEN", "PLANNED", "IN_PROGRESS", "DONE", "DECLINED"],
          description: "New status",
        },
      },
      required: ["feedbackId", "status"],
    },
  },
];
