import type { ToolDefinition } from "../tools";

/**
 * People tools: a project's roster, one person's projects, teams and open work,
 * and adding or removing people on projects and teams. Mirror
 * `GET|PUT|DELETE /projects/:id/members` and `POST|DELETE /projects/:id/teams/:teamId`.
 * Find a person's userId with list_org_members (it takes a name).
 */
const ROLES = ["MANAGER", "LEAD", "MEMBER", "VIEWER"];

export const peopleTools: ToolDefinition[] = [
  {
    name: "list_project_members",
    description: "List who is on a project: each person's userId, name, email, project role and team ids.",
    input_schema: {
      type: "object",
      properties: { projectId: { type: "string", description: "Project ID" } },
      required: ["projectId"],
    },
  },
  {
    name: "get_person",
    description:
      "Look up one person: their org role, the projects and teams they are on, and their open work items (not done or cancelled), all limited to projects you can see. Use list_org_members with a name to find their userId.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The person's userId" },
        assignmentLimit: { type: "integer", description: "How many open items to return (1-50, default 25)" },
      },
      required: ["userId"],
    },
  },
  {
    name: "add_project_member",
    confirm: true,
    description:
      "Add a person to a project, or change their role on it. Only an org admin or the project's manager may. Default role MEMBER. On a project limited to its team, this gives them access to it. Confirm with the user first.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        userId: { type: "string", description: "The person's userId (from list_org_members)" },
        role: { type: "string", enum: ROLES },
      },
      required: ["projectId", "userId"],
    },
  },
  {
    name: "remove_project_member",
    confirm: true,
    description:
      "Remove a person from a project (and so from its teams). Only an org admin or the project's manager may. Confirm with the user first.",
    input_schema: {
      type: "object",
      properties: { projectId: { type: "string" }, userId: { type: "string" } },
      required: ["projectId", "userId"],
    },
  },
  {
    name: "add_team_member",
    confirm: true,
    description:
      "Put a project member on one of the project's teams (list_teams gives team ids). They must be on the project first. Only an org admin or the project's manager may. Confirm with the user first.",
    input_schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        teamId: { type: "string" },
        userId: { type: "string" },
        isLead: { type: "boolean", description: "Make them a lead of the team" },
      },
      required: ["projectId", "teamId", "userId"],
    },
  },
  {
    name: "remove_team_member",
    confirm: true,
    description: "Take a person off a project's team. They stay on the project. Only an org admin or the project's manager may.",
    input_schema: {
      type: "object",
      properties: { projectId: { type: "string" }, teamId: { type: "string" }, userId: { type: "string" } },
      required: ["projectId", "teamId", "userId"],
    },
  },
];
