import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const Level = z.enum(["full", "busy"]);

const SharingState = z.object({
  level: z.enum(["full", "busy", "default"]).describe("The caller's own choice, or \"default\" while they follow the org's."),
  orgDefault: Level,
  effective: Level.describe("What is actually published into the caller's Outlook."),
});

export const setMicrosoftCalendarSharing = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/microsoft/calendar/sharing",
  operationId: "setMicrosoftCalendarSharing",
  summary: "How much Cosmos publishes into Outlook",
  description:
    "COSMOS-202: the sharing level Cosmos publishes a person's events at — \"full\" details or \"busy\" (free/busy " +
    "only, no title, details or link). `level` sets the caller's own (\"default\" follows the org); `orgDefault` sets " +
    "the org-wide default and needs INTEGRATION_MANAGE. Classified meetings stay busy-only either way. Not for API keys.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: {
    params: z.object({ orgId: Uuid }),
    body: z.object({ level: z.enum(["full", "busy", "default"]).optional(), orgDefault: Level.optional() }),
  },
  responses: { 200: SharingState },
  errors: [400, 401, 403, 404, 409],
});
