import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// The Outlook overlay on Program Management's calendar: the caller's own main
// Outlook calendar, through the caller's own Outlook Calendar connection.
//
// Internal, and `scopes: []`: no API key reaches it. It reads a person's
// mailbox, which no key in Cosmos is given, and there is deliberately no
// parameter that names a person: it is always the signed-in caller's.

const params = z.object({ orgId: z.string().uuid() });

export const listOutlookOverlay = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/program-calendar/outlook",
  operationId: "listOutlookOverlay",
  summary: "The caller's own Outlook events for the program calendar",
  description:
    "Events in the caller's main Outlook calendar overlapping the half-open "
    + "window [from, to), read through the caller's own Outlook Calendar "
    + "connection. `status` says when there is nothing to read: the "
    + "organization has not turned Outlook Calendar on (`off`), the caller has "
    + "not connected (`not_connected`) or must reconnect (`reconnect`), or "
    + "Microsoft did not answer (`unavailable`, with `detail`). Never another "
    + "person's calendar.",
  tags: ["Boards"],
  stability: "internal",
  scopes: [],
  request: {
    params,
    query: z.object({
      from: z.string().datetime(),
      to: z.string().datetime(),
    }),
  },
  responses: { 200: z.string() },
  errors: [400, 401, 403, 404],
});
