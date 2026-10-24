import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const Settings = z.object({
  blockParentWithOpenChildren: z
    .boolean()
    .describe("A parent cannot move into a Done status while a child is still open. Default on."),
  resolutions: z.array(z.string()).describe("The outcomes a transition into Done or Cancelled offers."),
});

const params = z.object({ orgId: Uuid });

export const getWorkflowSettings = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/workflow-settings",
  operationId: "getWorkflowSettings",
  summary: "Get the org's workflow settings",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params },
  responses: { 200: Settings.extend({ canManage: z.boolean() }) },
  errors: [401, 404],
});

export const updateWorkflowSettings = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/workflow-settings",
  operationId: "updateWorkflowSettings",
  summary: "Change the org's workflow settings",
  description: "Needs workflow-manage permission. Fields left out keep their value.",
  tags: ["Workflows"],
  stability: "internal",
  // No API-key scope grants workflow management: a signed-in admin only.
  scopes: [],
  request: { params, body: Settings.partial() },
  responses: { 200: Settings },
  errors: [400, 401, 403, 404],
});
