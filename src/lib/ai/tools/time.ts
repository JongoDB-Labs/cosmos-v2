import type { ToolDefinition } from "../tools";

export const timeTools: ToolDefinition[] = [
  {
    name: "log_time",
    description: "Log a time entry for the current user.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date (YYYY-MM-DD or ISO)" },
        hours: { type: "number", description: "Hours worked (>0)" },
        projectId: { type: "string", description: "Project id (optional)" },
        workItemId: { type: "string", description: "Work item id (optional)" },
        description: { type: "string" },
        billableType: {
          type: "string",
          enum: ["BILLABLE", "NON_BILLABLE", "INTERNAL"],
          description: "Default BILLABLE",
        },
        rate: { type: "number", description: "Optional hourly rate" },
        client: { type: "string" },
      },
      required: ["date", "hours"],
    },
  },
  {
    name: "list_time_entries",
    description: "List time entries with optional filters.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Inclusive lower bound (ISO)" },
        endDate: { type: "string", description: "Inclusive upper bound (ISO)" },
        projectId: { type: "string" },
        userId: { type: "string", description: "Filter by user id (defaults to all if permitted)" },
        billableType: { type: "string", enum: ["BILLABLE", "NON_BILLABLE", "INTERNAL"] },
        limit: { type: "number", description: "Max entries (default 100, cap 200)" },
      },
      required: [],
    },
  },
];
