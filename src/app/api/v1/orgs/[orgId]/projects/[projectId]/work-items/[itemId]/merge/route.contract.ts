import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { MergeRequest, MergeResult } from "@/lib/openapi/schemas/work-item-actions";

export const mergeWorkItem = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/merge",
  operationId: "mergeWorkItem",
  summary: "Merge a duplicate into another item",
  description:
    "Moves this item's comments, time, sub-items, attachments and links to `intoId`, then cancels it as merged. " +
    "Both items are edited, so the caller needs to be able to update each. It happens in one transaction.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }), body: MergeRequest },
  responses: { 200: MergeResult },
  errors: [400, 401, 403, 404],
});
