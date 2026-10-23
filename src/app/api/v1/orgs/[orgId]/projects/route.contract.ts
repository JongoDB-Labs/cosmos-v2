import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Project, Uuid } from "@/lib/openapi/schemas/common";

export const listProjects = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects",
  operationId: "listProjects",
  summary: "List projects",
  description:
    "Projects in the organization that the caller can see, newest first. A token limited to " +
    "certain projects lists only those, and team-scoped projects appear only to their members " +
    "and org admins.",
  tags: ["Projects"],
  stability: "stable",
  scopes: ["read"],
  request: {
    params: z.object({ orgId: Uuid }),
    query: z.object({
      archived: z.enum(["true", "false"]).optional()
        .describe("`true` lists archived projects instead of active ones."),
    }),
  },
  responses: { 200: z.array(Project) },
  errors: [400, 401, 403, 404],
  pagination: "cursor",
});
