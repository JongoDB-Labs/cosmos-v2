import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { Kpi, KpiWithSource } from "@/lib/openapi/schemas/goals";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listKpis = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/kpis",
  operationId: "listKpis",
  summary: "List KPIs",
  description: "With their data points. A KPI with an `autoSource` has its current value computed on read.",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.array(KpiWithSource) },
  errors: [400, 401, 403, 404],
});

export const createKpi = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/kpis",
  operationId: "createKpi",
  summary: "Create a KPI",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      name: z.string().min(1).max(200),
      description: z.string().nullish(),
      unit: z.string().max(50).optional().default(""),
      targetValue: z.number().optional().default(0),
      currentValue: z.number().optional().default(0),
      direction: z.enum(E.KpiDirection).optional().default("UP_GOOD"),
      autoSource: z.enum(E.KpiAutoSource).optional().default("MANUAL"),
      autoWindowDays: z.number().int().positive().nullish(),
    }),
  },
  responses: { 200: Kpi },
  errors: [400, 401, 403, 404, 409, 422],
  idempotency: true,
});
