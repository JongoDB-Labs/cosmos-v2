import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const LinkStatus = z.enum(["LINKED", "NEEDS_REVIEW", "UNLINKED", "NO_MATCH"]);

export const getSlackSetup = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/slack",
  operationId: "getSlackSetup",
  summary: "Slack notifications setup",
  description:
    "For admins (INTEGRATION_MANAGE): whether the instance's Slack app is configured, the redirect URL to register on it, " +
    "the org's Slack workspace connection and its delivery health, and every member's Slack link. Never a token.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: {
    200: z.object({
      appConfigured: z.boolean(),
      redirectUri: z.string(),
      scopes: z.array(z.string()),
      installation: z
        .object({
          teamId: z.string(),
          teamName: z.string(),
          installedBy: z.string().nullable(),
          status: z.enum(["ACTIVE", "ERROR"]),
          lastDeliveredAt: z.string().nullable(),
          lastErrorAt: z.string().nullable(),
          lastErrorCode: z.string().nullable(),
          queued: z.number().int(),
          linkOrigin: z.string().describe("Where message links point: COSMOS_PUBLIC_URL, else the address the install was made from."),
        })
        .nullable(),
      links: z.array(
        z.object({
          id: Uuid,
          userId: Uuid,
          name: z.string(),
          email: z.string(),
          status: LinkStatus,
          slackUserId: z.string().nullable(),
          approved: z.boolean(),
          optedOut: z.boolean(),
        }),
      ),
    }),
  },
  errors: [401, 403, 404],
});

export const deleteSlackConnection = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/slack",
  operationId: "deleteSlackConnection",
  summary: "Disconnect Slack",
  description:
    "For admins (INTEGRATION_MANAGE): asks Slack to revoke the bot token, then deletes it, the connection, every waiting " +
    "message and every member's match. Members' choices (opt-outs, unlinks) are kept.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: {
    200: z.object({ disconnected: z.boolean(), revoked: z.boolean(), revokeError: z.string().nullable() }),
  },
  errors: [401, 403, 404],
});
