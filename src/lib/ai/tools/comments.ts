import type { ToolDefinition } from "../tools";

export const commentTools: ToolDefinition[] = [
  {
    name: "add_comment",
    description: "Add a comment to a work item.",
    input_schema: {
      type: "object",
      properties: {
        workItemId: { type: "string", description: "Work item id" },
        content: { type: "string", description: "Comment body (max 10000 chars)" },
      },
      required: ["workItemId", "content"],
    },
  },
  {
    name: "list_comments",
    description: "List all comments on a work item, oldest first.",
    input_schema: {
      type: "object",
      properties: {
        workItemId: { type: "string" },
      },
      required: ["workItemId"],
    },
  },
  {
    name: "delete_comment",
    description: "Delete a comment. Only the author or org admin/owner.",
    input_schema: {
      type: "object",
      properties: {
        commentId: { type: "string" },
      },
      required: ["commentId"],
    },
  },
];
