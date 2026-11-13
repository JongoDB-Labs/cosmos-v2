import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const params = z.object({ orgId: Uuid, projectId: Uuid, boardId: Uuid });

/**
 * One widget as the builder saves it. Bounded, because this is free-form JSON
 * a person writes onto a row: the caps keep one layout from growing without
 * limit, and `.strict()` keeps keys nothing reads out of the store.
 */
const Widget = z
  .object({
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown()),
    layout: z
      .object({
        x: z.number().int().min(0).max(11),
        y: z.number().int().min(0).max(1000),
        w: z.number().int().min(1).max(12),
        h: z.number().int().min(1).max(100),
      })
      .strict(),
  })
  .strict();

const Layout = z
  .object({
    widgets: z.array(Widget),
    updatedAt: z.string(),
  })
  .nullable()
  .describe("The caller's own layout of this dashboard, or null when they use the shared one.");

export const getMyBoardLayout = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/boards/{boardId}/my-layout",
  operationId: "getMyBoardLayout",
  summary: "Get your own layout of a dashboard",
  tags: ["Boards"],
  stability: "internal",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.object({ layout: Layout }) },
  errors: [400, 401, 403, 404],
});

export const putMyBoardLayout = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/boards/{boardId}/my-layout",
  operationId: "putMyBoardLayout",
  summary: "Save your own layout of a dashboard",
  description:
    "Changes what the caller sees on this dashboard and nothing else. Anyone who can open the dashboard may keep their own layout of it.",
  tags: ["Boards"],
  stability: "internal",
  // A personal view preference, set from the builder: a signed-in person only.
  scopes: [],
  request: {
    params,
    body: z.object({ widgets: z.array(Widget).max(60) }).strict(),
  },
  responses: { 200: z.object({ layout: Layout }) },
  errors: [400, 401, 403, 404],
});

export const deleteMyBoardLayout = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/boards/{boardId}/my-layout",
  operationId: "deleteMyBoardLayout",
  summary: "Go back to the shared layout of a dashboard",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 204: null },
  errors: [400, 401, 403, 404],
});
