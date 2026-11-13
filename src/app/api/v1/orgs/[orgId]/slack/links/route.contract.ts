import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const matchSlackMembers = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/slack/links",
  operationId: "matchSlackMembers",
  summary: "Match members to Slack by email",
  description:
    "For admins (INTEGRATION_MANAGE): looks up every active member not yet linked (and who didn't unlink) in Slack by " +
    "their email. Links only a Slack account whose email is confirmed; a Slack account another member already has waits " +
    "for an admin. Stops at Slack's rate limit and says how many are left.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: {
    200: z.object({ linked: z.number().int(), review: z.number().int(), notFound: z.number().int(), remaining: z.number().int() }),
  },
  errors: [401, 403, 404, 409],
});
