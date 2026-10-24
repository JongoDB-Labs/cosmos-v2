import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Definition, Issue, Layout, workflowParams } from "../../route.contract";

export const saveWorkflowDraft = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}/draft",
  operationId: "saveWorkflowDraft",
  summary: "Save a workflow's draft",
  description:
    "The editor's autosave. The definition must be well-formed (a 422 lists what isn't); errors that " +
    "would stop a publish come back as `issues`. Creates the draft as the next version when there is none.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: workflowParams, body: z.object({ definition: Definition, layout: Layout.optional() }) },
  responses: { 200: z.object({ version: z.number().int(), issues: z.array(Issue) }) },
  errors: [400, 401, 403, 404, 422],
});

export const discardWorkflowDraft = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}/draft",
  operationId: "discardWorkflowDraft",
  summary: "Discard a workflow's draft",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: workflowParams },
  responses: { 200: z.object({ ok: z.literal(true) }) },
  errors: [401, 403, 404],
});
