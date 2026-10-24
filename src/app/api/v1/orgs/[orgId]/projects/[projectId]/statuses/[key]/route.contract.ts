import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { STATUS_CATEGORIES, Status } from "../route.contract";

// Any existing key: older columns allowed more than `StatusKey` does for new ones.
const keyParams = z.object({ orgId: Uuid, projectId: Uuid, key: z.string().min(1).max(120) });

export const updateStatus = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/projects/{projectId}/statuses/{key}",
  operationId: "updateStatus",
  summary: "Change a status",
  description:
    "Rename, recolour, reorder, archive or re-categorise a status. A category change applies to " +
    "future moves; it does not re-stamp dates already recorded.",
  tags: ["Statuses"],
  stability: "beta",
  scopes: ["items:write"],
  request: {
    params: keyParams,
    body: z.object({
      name: z.string().min(1).max(50).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      category: z.enum(STATUS_CATEGORIES).optional(),
      sortOrder: z.number().int().optional(),
      archived: z.boolean().optional(),
    }),
  },
  responses: { 200: Status },
  errors: [400, 401, 403, 404],
});

export const deleteStatus = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/statuses/{key}",
  operationId: "deleteStatus",
  summary: "Delete an empty status",
  description:
    "Only a status no work item is in can be deleted (409 otherwise: move the items first, or " +
    "archive it). The board columns showing it are removed with it.",
  tags: ["Statuses"],
  stability: "beta",
  scopes: ["items:write"],
  request: { params: keyParams },
  responses: { 204: null },
  errors: [400, 401, 403, 404, 409],
});
