import type { ToolDefinition } from "../tools";

export const noteTools: ToolDefinition[] = [
  {
    name: "create_note",
    description:
      "Create a note. visibility=PRIVATE keeps it to the author; PROJECT or ORG share it. projectId is informational — the model passes it for context but it is not stored on the Note row in cosmos.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title" },
        content: { type: "string", description: "Note content (markdown allowed)" },
        visibility: {
          type: "string",
          enum: ["PRIVATE", "PROJECT", "ORG"],
          description: "Who can see this note (default PRIVATE)",
        },
        projectId: { type: "string", description: "Optional project context for PROJECT visibility" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_note",
    description: "Update a note's fields. Only the author may update.",
    input_schema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        visibility: { type: "string", enum: ["PRIVATE", "PROJECT", "ORG"] },
      },
      required: ["noteId"],
    },
  },
  {
    name: "delete_note",
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
