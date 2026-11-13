import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const MySlack = z.object({
  available: z.boolean().describe("The org has Slack connected."),
  workspace: z.string().nullable(),
  status: z.enum(["LINKED", "NEEDS_REVIEW", "UNLINKED", "NO_MATCH"]).nullable(),
  reason: z.enum(["not_found", "unconfirmed", "conflict", "unlinked", "no_email"]).nullable(),
  notifyTypes: z.array(z.enum(["assigned", "mentioned"])),
});

export const getMySlackLink = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/slack/me",
  operationId: "getMySlackLink",
  summary: "My Slack link",
  description: "The signed-in member's Slack link in this org, and which notifications they get as Slack direct messages." +
    " Needs NOTIFICATION_READ; never available to API keys (403).",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: MySlack },
  errors: [401, 403, 404],
});

export const updateMySlackNotifications = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/slack/me",
  operationId: "updateMySlackNotifications",
  summary: "Choose my Slack notifications",
  description: "Which notifications also come to the member as a Slack direct message. An empty list opts out." +
    " Needs NOTIFICATION_READ; never available to API keys (403).",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }), body: z.strictObject({ notifyTypes: z.array(z.enum(["assigned", "mentioned"])).max(2) }) },
  responses: { 200: MySlack },
  errors: [400, 401, 403, 404],
});

export const linkMySlackAccount = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/slack/me",
  operationId: "linkMySlackAccount",
  summary: "Link my Slack account",
  description:
    "Looks the member up in the org's Slack workspace by their Cosmos email, now. Links only a Slack account whose email " +
    "is confirmed; one another member already has waits for an admin. Also relinks after an unlink." +
    " Needs NOTIFICATION_READ; never available to API keys (403).",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: MySlack },
  errors: [401, 403, 404, 409, 429],
});

export const unlinkMySlackAccount = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/slack/me",
  operationId: "unlinkMySlackAccount",
  summary: "Unlink my Slack account",
  description: "Nothing more is sent to the member in Slack, and they aren't matched again until they ask." +
    " Needs NOTIFICATION_READ; never available to API keys (403).",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: MySlack },
  errors: [401, 403, 404],
});
