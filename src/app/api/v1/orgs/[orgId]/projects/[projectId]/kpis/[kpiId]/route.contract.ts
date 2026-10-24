import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { DeletedRef, Uuid } from "@/lib/openapi/schemas/common";
import { Kpi } from "@/lib/openapi/schemas/goals";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid, kpiId: Uuid });

export const updateKpi = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/projects/{projectId}/kpis/{kpiId}",
  operationId: "updateKpi",
  summary: "Update a KPI",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().nullish(),
      unit: z.string().max(50).optional(),
      targetValue: z.number().optional(),
      currentValue: z.number().optional(),
      direction: z.enum(E.KpiDirection).optional(),
      sortOrder: z.number().int().optional(),
      autoSource: z.enum(E.KpiAutoSource).optional(),
      autoWindowDays: z.number().int().positive().nullish(),
    }),
  },
  responses: { 200: Kpi },
  errors: [400, 401, 403, 404],
});

export const deleteKpi = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/kpis/{kpiId}",
  operationId: "deleteKpi",
  summary: "Delete a KPI",
  description: "Deletes the KPI and its data points.",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["planning:write"],
  request: { params },
  responses: { 200: DeletedRef },
  errors: [400, 401, 403, 404],
});
