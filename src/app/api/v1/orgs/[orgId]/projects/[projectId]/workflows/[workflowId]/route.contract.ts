import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IsoDateTime, Uuid } from "@/lib/openapi/schemas/common";
import { Definition, Layout, MigrationMap, workflowParams } from "../route.contract";

export const WorkflowVersion = z.object({
  id: Uuid,
  version: z.number().int(),
  state: z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED"]),
  definition: Definition,
  layout: Layout,
  checksum: z.string(),
  migrationMap: MigrationMap.nullable(),
  publishedAt: IsoDateTime.nullable(),
  publishedById: Uuid.nullable(),
  createdAt: IsoDateTime,
});

export const getProjectWorkflow = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}",
  operationId: "getProjectWorkflow",
  summary: "A workflow, its draft and published versions, and its history",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params: workflowParams },
  responses: {
    200: z.object({
      id: Uuid,
      name: z.string(),
      description: z.string(),
      enforcement: z.enum(["SHADOW", "ENFORCE"]),
      assignedTo: z.array(Uuid.nullable()),
      draft: WorkflowVersion.nullable(),
      published: WorkflowVersion.nullable(),
      versions: z.array(
        z.object({
          id: Uuid,
          version: z.number().int(),
          state: z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED"]),
          publishedAt: IsoDateTime.nullable(),
          publishedById: Uuid.nullable(),
          createdAt: IsoDateTime,
        }),
      ),
    }),
  },
  errors: [401, 403, 404],
});

export const updateProjectWorkflow = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}",
  operationId: "updateProjectWorkflow",
  summary: "Rename a workflow, or change whether it enforces",
  description: "SHADOW records what it would refuse without refusing anything; ENFORCE refuses.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params: workflowParams,
    body: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().max(500).optional(),
      enforcement: z.enum(["SHADOW", "ENFORCE"]).optional(),
    }),
  },
  responses: { 200: z.object({ ok: z.literal(true) }) },
  errors: [400, 401, 403, 404, 409],
});

export const deleteProjectWorkflow = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}",
  operationId: "deleteProjectWorkflow",
  summary: "Delete a workflow nothing is assigned to",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: workflowParams },
  responses: { 200: z.object({ ok: z.literal(true) }) },
  errors: [401, 403, 404, 409],
});
