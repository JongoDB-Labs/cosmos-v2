import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Member, Uuid } from "@/lib/openapi/schemas/common";

export const listMembers = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/members",
  operationId: "listMembers",
  summary: "List members",
  description:
    "Everyone in the organization, longest-standing first. For a project-scoped key, limited to people on the " +
    "scoped projects: their project members, and the assignees, creators and commenters of their work items. " +
    "A token sees `user.email` only when it holds `members:read`; a browser session always does.",
  tags: ["Members"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: z.array(Member) },
  errors: [400, 401, 403, 404],
  pagination: "cursor",
  scopedFields: [{ scope: "members:read", paths: ["[].user.email"] }],
});
