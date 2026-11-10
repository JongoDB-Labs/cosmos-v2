import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// One program event. Internal with `scopes: []` for the same reason as the
// collection: the surface is new and starts closed to bearer tokens.

const params = z.object({ orgId: z.string().uuid(), eventId: z.string().uuid() });

export const getProgramEvent = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/program-events/{eventId}",
  operationId: "getProgramEvent",
  summary: "Get a program event",
  description:
    "404 rather than 403 when the event hangs off a project the caller cannot "
    + "see, so the response never confirms that a hidden event exists.",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: z.string() },
  errors: [401, 403, 404],
});

export const updateProgramEvent = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/program-events/{eventId}",
  operationId: "updateProgramEvent",
  summary: "Update a program event",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: { params, body: z.object({ title: z.string(), categoryId: z.string().uuid() }) },
  responses: { 200: z.string() },
  errors: [400, 401, 403, 404],
});

export const deleteProgramEvent = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/program-events/{eventId}",
  operationId: "deleteProgramEvent",
  summary: "Delete a program event",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: z.string() },
  errors: [401, 403, 404],
});
