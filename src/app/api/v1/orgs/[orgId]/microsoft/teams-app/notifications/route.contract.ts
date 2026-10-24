import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const NotifyType = z.enum(["assigned", "mentioned", "due_tomorrow"]);

const Settings = z.object({
  available: z.boolean().describe("Whether the org has Cosmos for Teams on."),
  chatReady: z.boolean().describe("Whether this person has a chat with the Cosmos bot (they installed it or wrote to it)."),
  notifyTypes: z.array(NotifyType),
});

export const getTeamsNotifications = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/microsoft/teams-app/notifications",
  operationId: "getTeamsNotifications",
  summary: "My Teams notification choices",
  description:
    "Which Cosmos notifications the signed-in person gets in their chat with the Cosmos bot in Teams (COSMOS-202 T2). " +
    "Needs NOTIFICATION_READ; never available to API keys (403).",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: Settings },
  errors: [401, 403, 404],
});

export const putTeamsNotifications = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/microsoft/teams-app/notifications",
  operationId: "putTeamsNotifications",
  summary: "Choose my Teams notifications",
  description:
    "Set which Cosmos notifications go to the signed-in person's chat with the Cosmos bot. Needs that chat first (409 otherwise). " +
    "Needs NOTIFICATION_READ; never available to API keys (403).",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }), body: z.object({ notifyTypes: z.array(NotifyType).max(3) }) },
  responses: { 200: Settings },
  errors: [400, 401, 403, 404, 409],
});
