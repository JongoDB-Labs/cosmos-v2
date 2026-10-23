import type { ToolDefinition } from "../tools";

/** Team tools — a project's teams, and which of them the asker is on (COSMOS-222). */
export const teamTools: ToolDefinition[] = [
  {
    name: "list_teams",
    description:
      "List a project's teams: id, name, key, memberCount, and isMine (whether the asking user is on it). Use it to answer questions about 'my team': find the team with isMine, then pass its id as teamId to list_work_items or query_work_items.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID whose teams to list" },
      },
      required: ["projectId"],
    },
  },
];
