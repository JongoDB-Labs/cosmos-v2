import type { ToolDefinition } from "../tools";

export const projectTools: ToolDefinition[] = [
  {
    name: "list_projects",
    description: "List active (non-archived) projects in the org.",
    input_schema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", description: "Include archived projects (default false)" },
      },
      required: [],
    },
  },
  {
    name: "list_cycles",
    description: "List cycles for a project (optionally filtered by status).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        status: { type: "string", enum: ["PLANNED", "ACTIVE", "COMPLETED"] },
        limit: { type: "number", description: "Max results (default 20, cap 50)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "create_cycle",
    description: "Create a new cycle (sprint/phase/etc) for a project.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        name: { type: "string", description: "Cycle name" },
        startDate: { type: "string", description: "ISO datetime" },
        endDate: { type: "string", description: "ISO datetime" },
        goal: { type: "string" },
        cycleKind: {
          type: "string",
          enum: ["SPRINT", "PHASE", "MODULE", "RUN", "EVENT_DAY", "RELEASE", "ITERATION"],
          description: "Default SPRINT",
        },
      },
      required: ["projectId", "name", "startDate", "endDate"],
    },
  },
];
