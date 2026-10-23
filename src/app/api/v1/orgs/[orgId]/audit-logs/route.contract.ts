import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { DateOrDateTime, Uuid } from "@/lib/openapi/schemas/common";
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
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      action: z.string().optional(),
      entity: z.string().optional(),
      userId: Uuid.optional(),
      startDate: DateOrDateTime.optional(),
      endDate: DateOrDateTime.optional(),
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
