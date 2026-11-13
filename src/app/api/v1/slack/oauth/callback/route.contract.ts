import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

export const slackOauthCallback = defineRoute({
  method: "get",
  path: "/slack/oauth/callback",
  operationId: "slackOauthCallback",
  summary: "Slack install callback",
  description:
    "Where Slack sends the admin back after \"Add to Slack\" (the redirect URL the Slack app registers). The state must " +
    "match its sealed cookie, be unexpired and unused, and belong to the signed-in admin, who must still manage " +
    "integrations. Redirects to Integrations with the outcome.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) },
  responses: {},
  errors: [401],
});
