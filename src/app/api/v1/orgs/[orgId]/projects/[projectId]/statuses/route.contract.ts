import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const STATUS_CATEGORIES = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const;

/** A key is what `columnKey` holds on every item in the status. */
export const StatusKey = z
  .string()
  .min(1)
  .max(30)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Lower-case letters, digits, '-' and '_'")
  .meta({ example: "in-review" });

export const Status = z
  .object({
    id: Uuid,
    key: z.string().meta({ example: "in-review" }),
    name: z.string().meta({ example: "In review" }),
    color: z.string().meta({ example: "#7dd3fc" }),
    category: z.enum(STATUS_CATEGORIES).describe(
      "What the status means: TODO (not started), IN_PROGRESS (started), DONE (finished), " +
        "CANCELLED (abandoned, not delivered). Start and end dates are captured from it.",
    ),
    sortOrder: z.number().int(),
    archived: z.boolean().describe("Hidden from pickers; items already in it keep it."),
    items: z.number().int().optional().describe("How many work items are in the status (with `counts=true`)."),
  })
  .meta({ id: "Status" });

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listStatuses = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/statuses",
  operationId: "listStatuses",
  summary: "List a project's statuses",
  description:
    "The statuses a project's work items can be in, in workflow order. Every item's `columnKey` " +
    "is one of these keys. Board columns show statuses; a status exists whether or not a board shows it.",
  tags: ["Statuses"],
  stability: "beta",
  scopes: ["read"],
  request: {
    params,
    query: z.object({
      archived: z.enum(["false", "true"]).optional().describe("`true` includes archived statuses."),
      counts: z.enum(["false", "true"]).optional().describe("`true` adds each status's item count."),
    }),
  },
  responses: { 200: z.array(Status) },
  errors: [400, 401, 403, 404],
});

export const createStatus = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/statuses",
  operationId: "createStatus",
  summary: "Add a status to a project",
  description: "Needs board-update permission or project manager. The key cannot change later.",
  tags: ["Statuses"],
  stability: "beta",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      key: StatusKey,
      name: z.string().min(1).max(50),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      category: z.enum(STATUS_CATEGORIES),
      sortOrder: z.number().int().optional(),
    }),
  },
  responses: { 201: Status },
  errors: [400, 401, 403, 404, 409],
});
