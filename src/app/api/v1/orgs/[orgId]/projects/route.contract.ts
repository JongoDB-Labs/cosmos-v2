import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Project, ProjectWithBoards, Uuid } from "@/lib/openapi/schemas/common";

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
      archived: z.enum(["false", "true", "0", "1"]).optional()
        .describe("`true` (or `1`) lists archived projects instead of active ones.")
        .meta({ example: "false" }),
    }),
  },
  responses: { 200: z.array(Project) },
  errors: [400, 401, 403, 404],
  pagination: "cursor",
});

export const createProject = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects",
  operationId: "createProject",
  summary: "Create a project",
  description:
    "Creates a project, optionally from a template (which sets up its boards and enabled features). " +
    "The creator becomes its manager. Returns 409 when the key is taken.",
  tags: ["Projects"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params: z.object({ orgId: Uuid }),
    body: z.object({
      name: z.string().min(1).max(100),
      key: z.string().min(2).max(10).regex(/^[A-Z][A-Z0-9]*$/, "Key must be uppercase alphanumeric"),
      description: z.string().nullish(),
      templateId: z.string().uuid().nullish(),
      sector: z.string().nullish(),
    }),
  },
  responses: { 201: ProjectWithBoards },
  errors: [400, 401, 403, 404, 409],
});
