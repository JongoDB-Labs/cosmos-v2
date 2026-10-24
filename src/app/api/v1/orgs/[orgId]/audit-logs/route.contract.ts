import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { clampedInt, QueryDate, Uuid } from "@/lib/openapi/schemas/common";
import { AuditLogEntry } from "@/lib/openapi/schemas/audit";

export const listAuditLogs = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/audit-logs",
  operationId: "listAuditLogs",
  summary: "List audit log entries",
  description: "Newest first, a page at a time. Needs audit-log access (org admins by default).",
  tags: ["Audit"],
  stability: "stable",
  scopes: ["audit:read"],
  request: {
    params: z.object({ orgId: Uuid }),
    query: z.object({
      page: clampedInt(1, Number.MAX_SAFE_INTEGER, 1).describe("From 1; lower values read as 1."),
      limit: clampedInt(1, 200, 50).describe("1 to 200, default 50; values outside are clamped."),
      action: z.string().optional(),
      entity: z.string().optional(),
      userId: Uuid.optional(),
      startDate: QueryDate.optional(),
      endDate: QueryDate.optional(),
    }),
  },
  responses: {
    200: z.object({
      data: z.array(AuditLogEntry),
      total: z.number().int(),
      page: z.number().int(),
      limit: z.number().int(),
    }).meta({ id: "AuditLogPage" }),
  },
  errors: [400, 401, 403, 404],
});
