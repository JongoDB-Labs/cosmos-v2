import type { ToolDefinition } from "../tools";

/**
 * Meeting tools — the org's sync meetings (SyncMeeting model). Mirrors
 * `api/v1/orgs/[orgId]/meetings/…`.
 */
export const meetingTools: ToolDefinition[] = [
  {
    name: "list_meetings",
    description: "List the org's meetings (optionally filter by project, sprint, type, or status).",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Optional project ID filter" },
        sprintId: { type: "string", description: "Optional sprint/interval ID filter" },
        meetingType: {
          type: "string",
          enum: ["STANDUP", "SPRINT_PLANNING", "SPRINT_REVIEW", "RETROSPECTIVE", "OTHER"],
          description: "Optional type filter",
        },
        status: {
          type: "string",
          enum: ["SCHEDULED", "IN_PROGRESS", "MEETING_COMPLETED", "CANCELLED"],
          description: "Optional status filter",
        },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
      required: [],
    },
  },
  {
    name: "create_meeting",
    description: "Schedule a meeting.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title" },
        meetingDate: { type: "string", description: "ISO datetime of the meeting (required)" },
        projectId: { type: "string", description: "Optional project ID" },
        sprintId: { type: "string", description: "Optional sprint/interval ID" },
        meetingType: {
          type: "string",
          enum: ["STANDUP", "SPRINT_PLANNING", "SPRINT_REVIEW", "RETROSPECTIVE", "OTHER"],
          description: "Default STANDUP",
        },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["title", "meetingDate"],
    },
  },
  {
    name: "update_meeting",
    description: "Update a meeting's title, date (reschedule), status, or notes.",
    input_schema: {
      type: "object",
      properties: {
        meetingId: { type: "string", description: "Meeting ID to update" },
        title: { type: "string" },
        meetingDate: { type: "string", description: "ISO datetime (reschedule)" },
        status: {
          type: "string",
          enum: ["SCHEDULED", "IN_PROGRESS", "MEETING_COMPLETED", "CANCELLED"],
        },
        notes: { type: "string" },
      },
      required: ["meetingId"],
    },
  },
  {
    name: "delete_meeting",
    description: "Delete a meeting.",
    input_schema: {
      type: "object",
      properties: {
        meetingId: { type: "string", description: "Meeting ID to delete" },
      },
      required: ["meetingId"],
    },
  },
];
