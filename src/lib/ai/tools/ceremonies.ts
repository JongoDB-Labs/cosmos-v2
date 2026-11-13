import type { ToolDefinition } from "../tools";

/**
 * Sprint ceremony tools: the planning and review/retro boards a team runs for
 * one sprint, with their notes and action items. Mirrors
 * `api/v1/orgs/[orgId]/projects/[projectId]/intervals/[intervalId]/ceremony/…`
 * and calls the same shared service (lib/intervals/ceremony.server.ts).
 *
 * Standups are not here: a standup is a meeting type, handled by the meeting
 * tools.
 */

const projectId = { type: "string", description: "Project ID" };
const intervalId = { type: "string", description: "Sprint (interval) ID the ceremony is for" };

export const ceremonyTools: ToolDefinition[] = [
  {
    name: "get_ceremony",
    description:
      "Read a sprint ceremony (sprint planning or sprint review/retro board). Without boardId, lists the " +
      "project's ceremony boards you can see, each with its ceremony for the sprint (status, note and action " +
      "counts): use it to find a boardId. With boardId, returns the full review: sprint, metrics, what " +
      "shipped, what carried over, the next sprint, and the ceremony's notes and action items. Without " +
      "intervalId, uses the sprint the board would open on (the active one, else the latest completed). " +
      "A note's author is withheld unless the board shows authors.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId: { type: "string", description: "Sprint (interval) ID. Optional; defaults as described." },
        boardId: { type: "string", description: "Ceremony board ID. Optional; omit to list the boards." },
        teamId: { type: "string", description: "Optional team ID: scope the review's work to that team's members" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "open_ceremony",
    description:
      "Open (start) the ceremony on a ceremony board for a sprint, creating it the first time. Re-opening a " +
      "closed ceremony is allowed. Facilitators only: needs permission to complete sprints, or being a manager " +
      "of the project.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        boardId: { type: "string", description: "Ceremony board ID (from get_ceremony)" },
        kind: { type: "string", enum: ["PLANNING", "REVIEW"], description: "PLANNING or REVIEW" },
      },
      required: ["projectId", "intervalId", "boardId", "kind"],
    },
  },
  {
    name: "close_ceremony",
    confirm: true,
    description:
      "Close a running ceremony, recording that it was held. Facilitators only, as for open_ceremony.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        ceremonyId: { type: "string", description: "Ceremony ID (from get_ceremony)" },
      },
      required: ["projectId", "intervalId", "ceremonyId"],
    },
  },
  {
    name: "add_ceremony_note",
    description:
      "Add a note to a column of an open ceremony board (for example a retro's went-well column). Any project " +
      "member may. The column must be one of the board's columns (keys from get_ceremony).",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        ceremonyId: { type: "string", description: "Ceremony ID (from get_ceremony)" },
        columnKey: { type: "string", description: "Column key on the ceremony board" },
        text: { type: "string", description: "Note text (max 2000 chars)" },
      },
      required: ["projectId", "intervalId", "ceremonyId", "columnKey", "text"],
    },
  },
  {
    name: "update_ceremony_note",
    description:
      "Edit a note's text. Only its author or a facilitator may, and not once the ceremony is closed.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        noteId: { type: "string", description: "Note ID (from get_ceremony)" },
        text: { type: "string", description: "New note text (max 2000 chars)" },
      },
      required: ["projectId", "intervalId", "noteId", "text"],
    },
  },
  {
    name: "delete_ceremony_note",
    confirm: true,
    description: "Delete a note. Only its author or a facilitator may.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        noteId: { type: "string", description: "Note ID (from get_ceremony)" },
      },
      required: ["projectId", "intervalId", "noteId"],
    },
  },
  {
    name: "add_ceremony_action",
    description:
      "Add an action item to an open ceremony. Any project member may. Owner and due date are optional.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        ceremonyId: { type: "string", description: "Ceremony ID (from get_ceremony)" },
        text: { type: "string", description: "What will be done (max 2000 chars)" },
        ownerId: { type: "string", description: "Optional owner user ID (a member of this organization)" },
        dueDate: { type: "string", description: "Optional due date (ISO date)" },
      },
      required: ["projectId", "intervalId", "ceremonyId", "text"],
    },
  },
  {
    name: "update_ceremony_action",
    description:
      "Edit an action item's text, owner or due date (null clears owner or due date). Not once the ceremony is closed.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        actionId: { type: "string", description: "Action item ID (from get_ceremony)" },
        text: { type: "string" },
        ownerId: { type: "string", description: "Owner user ID; pass null to clear" },
        dueDate: { type: "string", description: "ISO date; pass null to clear" },
      },
      required: ["projectId", "intervalId", "actionId"],
    },
  },
  {
    name: "delete_ceremony_action",
    confirm: true,
    description:
      "Delete an action item. A work item already promoted from it is kept.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        actionId: { type: "string", description: "Action item ID (from get_ceremony)" },
      },
      required: ["projectId", "intervalId", "actionId"],
    },
  },
  {
    name: "promote_ceremony_action",
    description:
      "Turn an action item into a tracked work item in the project's to-do column, on the next sprint if one " +
      "exists. Promoting twice returns the same work item. Needs permission to create work items, or being a " +
      "manager of the project.",
    input_schema: {
      type: "object",
      properties: {
        projectId,
        intervalId,
        actionId: { type: "string", description: "Action item ID (from get_ceremony)" },
      },
      required: ["projectId", "intervalId", "actionId"],
    },
  },
];
