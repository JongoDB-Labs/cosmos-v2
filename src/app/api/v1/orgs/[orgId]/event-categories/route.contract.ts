import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { ProgramEventFilterQuery } from "@/lib/openapi/schemas/program-calendar";

// The colour bands on the program calendar. Internal, `scopes: []`.

const params = z.object({ orgId: z.string().uuid() });

export const listEventCategories = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/event-categories",
  operationId: "listEventCategories",
  summary: "List event categories",
  description:
    "With from/to, each category carries the count of events it holds in that "
    + "window, under the same project, owner and custom filters as the events "
    + "list (`listProgramEvents`), so the counts describe the calendar being "
    + "shown. The count ignores the category filter, so a category switched "
    + "off still reports what turning it back on would bring.",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: {
    params,
    query: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      ...ProgramEventFilterQuery,
    }),
  },
  responses: { 200: z.string() },
  errors: [400, 401, 403, 404],
});

export const createEventCategory = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/event-categories",
  operationId: "createEventCategory",
  summary: "Create an event category",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: { params, body: z.object({ name: z.string(), tintRgb: z.string(), textColor: z.string() }) },
  responses: { 201: z.string() },
  errors: [400, 401, 403, 404],
});
