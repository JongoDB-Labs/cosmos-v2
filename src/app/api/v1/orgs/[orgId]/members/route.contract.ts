import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Member, Uuid } from "@/lib/openapi/schemas/common";

export const listMembers = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/members",
  operationId: "listMembers",
  summary: "List members",
  description: "Everyone in the organization, longest-standing first. Email addresses are not returned to API tokens.",
  tags: ["Members"],
  stability: "stable",
  scopes: ["members:read"],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: z.array(Member) },
  errors: [400, 401, 403, 404],
  pagination: "cursor",
  sessionOnly: ["email"],
});
