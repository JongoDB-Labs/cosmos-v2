import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Issue, MigrationMap, workflowParams } from "../../route.contract";

const Ref = z.object({ id: z.string(), name: z.string() });
export const WorkflowDiff = z.object({
  addedStatuses: z.array(z.string()),
  removedStatuses: z
    .array(z.object({ key: z.string(), items: z.number().int() }))
    .describe("Statuses the draft drops, with how many items the workflow governs in each."),
  addedTransitions: z.array(Ref),
  removedTransitions: z.array(Ref),
  changedTransitions: z.array(Ref),
});

export const previewWorkflowPublish = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}/publish",
  operationId: "previewWorkflowPublish",
  summary: "What publishing the draft would do",
  description: "The draft's errors and warnings, and its diff against the published version.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params: workflowParams },
  responses: { 200: z.object({ version: z.number().int(), issues: z.array(Issue), diff: WorkflowDiff }) },
  errors: [401, 403, 404, 422],
});

export const publishWorkflow = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}/publish",
  operationId: "publishWorkflow",
  summary: "Publish the draft",
  description:
    "Every transition from now on runs against it. Refused (422 `workflow_invalid`) while the draft has " +
    "errors, and (409 `migration_map_required`) when it drops statuses that hold items without " +
    "`migrationMap` saying where they go; those items then move in the background.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: workflowParams, body: z.object({ migrationMap: MigrationMap.optional() }) },
  responses: {
    200: z.object({ version: z.number().int(), diff: WorkflowDiff, migrationMap: MigrationMap }),
  },
  errors: [400, 401, 403, 404, 409, 422],
});
