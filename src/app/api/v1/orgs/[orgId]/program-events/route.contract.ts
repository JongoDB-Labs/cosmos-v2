import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// The program calendar's events.
//
// Internal, and `scopes: []`, which refuses every bearer token. The surface is
// new, so no key minted earlier could reach it, and nothing is taken away by
// starting closed — a scope can be opened later once there is a caller that
// needs one. Opening it first and narrowing afterwards is the move that cannot
// be undone.

const params = z.object({ orgId: z.string().uuid() });

export const listProgramEvents = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/program-events",
  operationId: "listProgramEvents",
  summary: "List program events in a window",
  description:
    "Events overlapping the half-open window [from, to). A multi-day event is "
    + "returned for every window it crosses, not only the one it starts in. "
    + "`projectId` alone returns only that project's events; add "
    + "`includeOrgEvents=true` to also return the org-level events, which have no project.",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: {
    params,
    query: z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
      categoryIds: z.string().optional(),
      ownerKeys: z.string().optional(),
      projectId: z.string().uuid().optional(),
      includeOrgEvents: z.enum(["true", "false"]).optional(),
      showOnDashboardOnly: z.enum(["true", "false"]).optional(),
      customerAttending: z.enum(["true", "false"]).optional(),
      hasDeliverable: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: { 200: z.string() },
  errors: [400, 401, 403, 404],
});

export const createProgramEvent = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/program-events",
  operationId: "createProgramEvent",
  summary: "Create a program event",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: { params, body: z.object({ title: z.string(), categoryId: z.string().uuid() }) },
  responses: { 201: z.string() },
  errors: [400, 401, 403, 404],
});
