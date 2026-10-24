import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IsoDateTime, Uuid } from "@/lib/openapi/schemas/common";

/** A rule as the API shows it. The cap (`actorCap`) stays server-side. */
export const AutomationRuleDto = z.object({
  id: Uuid,
  projectId: Uuid.nullable(),
  name: z.string(),
  enabled: z.boolean(),
  spec: z.unknown(),
  revision: z.number().int(),
  ownerId: Uuid.nullable(),
  allowChain: z.boolean(),
  templateKey: z.string().nullable(),
  disabledReason: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const listAutomationRules = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/automations",
  operationId: "listAutomationRules",
  summary: "List automation rules",
  description: "A project's rules with `projectId`, else the org-wide ones. Needs the automation-manage permission (or, for a project, its manager).",
  tags: ["Automations"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid }), query: z.object({ projectId: Uuid.optional() }) },
  responses: { 200: z.array(AutomationRuleDto) },
  errors: [401, 403, 404],
});

export const createAutomationRule = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/automations",
  operationId: "createAutomationRule",
  summary: "Create an automation rule",
  description:
    "The caller becomes its owner: its actions run with the caller's access as it is at each run, never more than they held when they saved it.",
  tags: ["Automations"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params: z.object({ orgId: Uuid }),
    body: z.object({
      projectId: Uuid.nullable().default(null),
      name: z.string().trim().min(1).max(120),
      spec: z.unknown(),
      enabled: z.boolean().optional(),
      allowChain: z.boolean().optional(),
      templateKey: z.string().max(80).nullable().optional(),
    }),
  },
  responses: { 201: AutomationRuleDto },
  errors: [400, 401, 403, 404, 422],
});
