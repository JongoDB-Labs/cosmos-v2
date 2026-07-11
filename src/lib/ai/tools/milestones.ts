import type { ToolDefinition } from "../tools";

/**
 * Milestone tools — project delivery milestones with a due date and status.
 * Mirrors `api/v1/orgs/[orgId]/projects/[projectId]/milestones/…`.
 */
export const milestoneTools: ToolDefinition[] = [
  {
    name: "list_milestones",
    description:
      "List a project's milestones (due date, status, schedule baseline/projected/actual dates).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose milestones to list" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "create_milestone",
    description: "Create a milestone in a project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID to create the milestone in" },
        title: { type: "string", description: "Milestone title (max 200 chars)" },
        description: { type: "string", description: "Optional description" },
        dueDate: { type: "string", description: "ISO datetime due date (required)" },
        ownerId: { type: "string", description: "Optional owner user ID" },
        autoStatus: { type: "boolean", description: "Derive status from linked items (default true)" },
      },
      required: ["projectId", "title", "dueDate"],
    },
  },
  {
    name: "update_milestone",
    description: "Update a milestone's fields.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the milestone belongs to" },
        milestoneId: { type: "string", description: "Milestone ID to update" },
        title: { type: "string" },
        description: { type: "string" },
        dueDate: { type: "string", description: "ISO datetime" },
        status: { type: "string", enum: ["UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED"] },
        ownerId: { type: "string" },
        autoStatus: { type: "boolean" },
      },
      required: ["projectId", "milestoneId"],
    },
  },
  {
    name: "delete_milestone",
    description: "Delete a milestone.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID the milestone belongs to" },
        milestoneId: { type: "string", description: "Milestone ID to delete" },
      },
      required: ["projectId", "milestoneId"],
    },
  },
];
