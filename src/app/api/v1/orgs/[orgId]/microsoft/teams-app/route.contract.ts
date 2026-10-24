import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const getTeamsAppSetup = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/microsoft/teams-app",
  operationId: "getTeamsAppSetup",
  summary: "Cosmos for Teams setup",
  description:
    "For admins (INTEGRATION_MANAGE): whether Cosmos for Teams is installed, whether Outlook Calendar " +
    "(whose tenant it answers for) is ready, the bot's Microsoft app id and the messaging endpoint to register.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: {
    200: z.object({
      installed: z.boolean(),
      calendarReady: z.boolean(),
      appId: z.string().nullable(),
      messagingEndpoint: z.string(),
      publicUrlConfigured: z.boolean().describe("Whether COSMOS_PUBLIC_URL is set; the tabs' sign-in needs it."),
      appIdUri: z.string().nullable().describe("For tab sign-in: the Application ID URI to set under Expose an API (null until COSMOS_PUBLIC_URL is set)."),
    }),
  },
  errors: [401, 403, 404],
});
