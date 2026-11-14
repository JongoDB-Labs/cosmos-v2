import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// For the assignee picker, which marks the people who can't see the project.
// Internal: browser sessions only (no scopes, so no API key reaches it).
export const listProjectMemberVisibility = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/member-visibility",
  operationId: "listProjectMemberVisibility",
  summary: "Which members can see a project",
  description:
    "For each current member of the organization, whether they can see this project's work items, judged as " +
    "them: the same rule that decides whether they are told about one. Only for someone who may change work " +
    "items in the project; anyone else, and a project they can't see or that doesn't exist, is a 403.",
  tags: ["Projects"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid }) },
  responses: { 200: z.array(z.object({ userId: Uuid, canSee: z.boolean() })) },
  errors: [400, 401, 403, 404],
});
