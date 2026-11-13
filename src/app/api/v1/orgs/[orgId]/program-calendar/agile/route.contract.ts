import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// The Agile overlay on Program Management's calendar: Program Increments,
// sprints, releases and work-item due dates in one window.
//
// Internal, and `scopes: []`, like the rest of the program calendar: no API key
// reaches it. The same rows are already open to keys through the intervals and
// work-item APIs; this is the calendar's own reader, and starting closed is the
// choice that can be undone.

const params = z.object({ orgId: z.string().uuid() });

export const listAgileOverlay = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/program-calendar/agile",
  operationId: "listAgileOverlay",
  summary: "Agile cadence and due dates for the program calendar",
  description:
    "Program Increments, sprints and releases overlapping the half-open window "
    + "[from, to), and the work items due in it, from the projects the caller may "
    + "read: intervals under SPRINT_READ, work items under ITEM_READ. `projectId` "
    + "narrows to one project and never widens.",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: {
    params,
    query: z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
      projectId: z.string().uuid().optional(),
    }),
  },
  responses: { 200: z.string() },
  errors: [400, 401, 403, 404],
});
