import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IsoDateTime, Uuid } from "@/lib/openapi/schemas/common";

export const listWorkflowTemplates = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/workflow-templates",
  operationId: "listWorkflowTemplates",
  summary: "List the org's workflow templates",
  description: "Workflows a project can start from. A project copies a template; it never shares it live.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }) },
  responses: {
    200: z.array(z.object({ id: Uuid, name: z.string(), description: z.string(), updatedAt: IsoDateTime })),
  },
  errors: [401, 403, 404],
});

export const createWorkflowTemplate = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/workflow-templates",
  operationId: "createWorkflowTemplate",
  summary: "Save a project's workflow as an org template",
  description: "Its published definition, with the statuses it uses. Needs the workflow-manage permission.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params: z.object({ orgId: Uuid }),
    body: z.object({ fromWorkflowId: Uuid, name: z.string().trim().min(1).max(80), description: z.string().max(500).optional() }),
  },
  responses: { 201: z.object({ id: Uuid }) },
  errors: [400, 401, 403, 404, 409],
});
