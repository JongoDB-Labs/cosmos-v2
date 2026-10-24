import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { Activity } from "@/lib/openapi/schemas/work-items";

export const listWorkItemActivity = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/activity",
  operationId: "listWorkItemActivity",
  summary: "List a work item's changes",
  description: "Its 100 latest changes, newest first: who changed which field, from what, to what.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }) },
  responses: { 200: z.array(Activity) },
  errors: [400, 401, 403, 404],
});
