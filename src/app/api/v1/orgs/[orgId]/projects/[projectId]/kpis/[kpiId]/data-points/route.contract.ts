import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { KpiDataPoint } from "@/lib/openapi/schemas/goals";

const params = z.object({ orgId: Uuid, projectId: Uuid, kpiId: Uuid });

export const listKpiDataPoints = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/kpis/{kpiId}/data-points",
  operationId: "listKpiDataPoints",
  summary: "List KPI data points",
  description: "Oldest first.",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.array(KpiDataPoint) },
  errors: [400, 401, 403, 404],
});

export const createKpiDataPoint = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/kpis/{kpiId}/data-points",
  operationId: "createKpiDataPoint",
  summary: "Record a KPI value",
  description: "The KPI's current value becomes its most recent data point's.",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      value: z.number(),
      // Coerced, as before contracts: epoch milliseconds and offset-less datetimes work.
      recordedAt: z.coerce
        .date()
        .optional()
        .meta({ type: "string", format: "date-time" })
        .describe("When the value was measured; epoch milliseconds also work. Defaults to now."),
      note: z.string().nullish(),
    }),
  },
  responses: { 200: KpiDataPoint },
  errors: [400, 401, 403, 404],
});
