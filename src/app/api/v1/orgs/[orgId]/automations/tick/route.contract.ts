import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const tickAutomations = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/automations/tick",
  operationId: "tickAutomations",
  summary: "Run the org's scheduled automations that are due",
  description:
    "For a scheduler: the app also runs them every minute itself. Safe to call at any time; a rule runs at most once per slot. Needs a `rules:run` key (or RULES_RUN).",
  tags: ["Automations"],
  stability: "internal",
  scopes: ["rules:run"],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: z.object({ ran: z.number().int() }) },
  errors: [401, 403, 404],
});
