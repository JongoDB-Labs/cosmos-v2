import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { AutomationRuleDto } from "../route.contract";

const params = z.object({ orgId: Uuid, ruleId: Uuid });

export const getAutomationRule = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/automations/{ruleId}",
  operationId: "getAutomationRule",
  summary: "Get an automation rule",
  tags: ["Automations"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params },
  responses: { 200: AutomationRuleDto },
  errors: [401, 403, 404],
});

export const updateAutomationRule = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/automations/{ruleId}",
  operationId: "updateAutomationRule",
  summary: "Edit an automation rule",
  description:
    "The editor becomes the rule's owner and its cap is theirs, so saving is how a rule whose owner left is taken over. `revision` must be the one read: a stale one is a 409.",
  tags: ["Automations"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      revision: z.number().int(),
      name: z.string().trim().min(1).max(120).optional(),
      spec: z.unknown().optional(),
      enabled: z.boolean().optional(),
      allowChain: z.boolean().optional(),
    }),
  },
  responses: { 200: AutomationRuleDto.extend({ warnings: z.array(z.string()) }) },
  errors: [400, 401, 403, 404, 409, 422],
});

export const deleteAutomationRule = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/automations/{ruleId}",
  operationId: "deleteAutomationRule",
  summary: "Delete an automation rule, with its run history",
  tags: ["Automations"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params },
  responses: { 200: z.object({ deleted: z.literal(true) }) },
  errors: [401, 403, 404],
});
