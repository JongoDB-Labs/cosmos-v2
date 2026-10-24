import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const downloadTeamsAppPackage = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/microsoft/teams-app/package",
  operationId: "downloadTeamsAppPackage",
  summary: "Download the Cosmos for Teams app package",
  description:
    "For admins (INTEGRATION_MANAGE): the zip (manifest.json and icons) to upload to the tenant's Teams " +
    "app catalog. Built for this instance: its bot is the Microsoft sign-in app and only this host's links unfurl.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: z.string().describe("application/zip") },
  errors: [401, 403, 404, 409],
});
