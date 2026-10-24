import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IsoDateTime, Uuid } from "@/lib/openapi/schemas/common";

// Shared by every workflow-editor contract (the editor is their only client,
// so they are all internal for now).

export const projectParams = z.object({ orgId: Uuid, projectId: Uuid });
export const workflowParams = projectParams.extend({ workflowId: Uuid });

export const Definition = z
  .record(z.string(), z.unknown())
  .describe("A WorkflowDefinition (src/lib/workflow/definition.ts), validated on save.");
export const Layout = z
  .record(z.string(), z.unknown())
  .describe("Editor-only data: node positions, and on a template the statuses it brings.");
export const MigrationMap = z
  .record(z.string(), z.string())
  .describe("Status key → status key, for the items in statuses a change drops.");
export const Issue = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
});

export const WorkflowSummary = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  enforcement: z.enum(["SHADOW", "ENFORCE"]),
  published: z.object({ version: z.number().int(), publishedAt: IsoDateTime.nullable() }).nullable(),
  draft: z.object({ version: z.number().int(), createdAt: IsoDateTime }).nullable(),
  /** Work-item type ids; null is the project default. */
  assignedTo: z.array(Uuid.nullable()),
});

export const listProjectWorkflows = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/workflows",
  operationId: "listProjectWorkflows",
  summary: "List a project's workflows and what each governs",
  description: "A project or type with no assignment runs the open workflow, generated from its statuses.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params: projectParams },
  responses: {
    200: z.object({
      workflows: z.array(WorkflowSummary),
      assignments: z.array(z.object({ workItemTypeId: Uuid.nullable(), workflowId: Uuid, assignedAt: IsoDateTime })),
    }),
  },
  errors: [401, 403, 404],
});

export const createProjectWorkflow = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/workflows",
  operationId: "createProjectWorkflow",
  summary: "Create a workflow, with a draft",
  description:
    "From the open workflow (today's behaviour), a copy of another of the project's workflows, or an " +
    "org template, whose statuses are added to the project. It governs nothing until published and assigned.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params: projectParams,
    body: z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().max(500).optional(),
      from: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("open") }),
        z.object({ kind: z.literal("copy"), workflowId: Uuid }),
        z.object({ kind: z.literal("template"), templateId: Uuid }),
      ]),
    }),
  },
  responses: { 201: z.object({ id: Uuid }) },
  errors: [400, 401, 403, 404, 409],
});
