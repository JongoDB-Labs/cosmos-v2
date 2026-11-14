import type { ToolDefinition } from "../tools";

export const noteTools: ToolDefinition[] = [
  {
    name: "list_notes",
    description:
      "List notes. Returns id, title, visibility, authorId, createdAt, updatedAt \u2014 NOT the note body. " +
      "Use this to find a note's id before update_note or delete_note. Your own PRIVATE notes are included; " +
      "other people's are not. Pass visibility to narrow to PRIVATE (yours), ORG or PROJECT.",
    input_schema: {
      type: "object",
      properties: {
        visibility: { type: "string", description: "PRIVATE (yours only), ORG, or PROJECT" },
        limit: { type: "number", description: "Max results (default 50, cap 100)" },
      },
    },
  },
  {
    name: "create_note",
    description:
      "Create a note. It is always saved private to its author. To share it (PROJECT or ORG), call share_note next, which asks the user first. " +
      "projectId is informational — the model passes it for context but it is not stored on the Note row in cosmos.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title" },
        content: { type: "string", description: "Note content (markdown allowed)" },
        projectId: { type: "string", description: "Optional project context" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_note",
    description:
      "Update a note's title or content, or make it visible to FEWER people (ORG to PROJECT or PRIVATE, PROJECT to PRIVATE). Only the author may update. " +
      "To let more people see it, use share_note, which asks the user first.",
    input_schema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        visibility: { type: "string", enum: ["PRIVATE", "PROJECT", "ORG"], description: "Only to narrow who sees it" },
      },
      required: ["noteId"],
    },
  },
  {
    name: "share_note",
    confirm: true,
    description:
      "Change who sees a note: PRIVATE (only its author), PROJECT or ORG (shared). Only its author can. Confirm with the user first.",
    input_schema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "The note's id (from list_notes)" },
        visibility: { type: "string", enum: ["PRIVATE", "PROJECT", "ORG"], description: "Who sees it" },
      },
      required: ["noteId", "visibility"],
    },
  },
  {
    name: "delete_note",
    confirm: true,
    description: "Delete a note. Only the author or org admin/owner may delete.",
    input_schema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
      },
      required: ["noteId"],
    },
  },
];
