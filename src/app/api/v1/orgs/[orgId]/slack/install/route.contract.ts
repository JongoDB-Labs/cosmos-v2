import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const startSlackInstall = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/slack/install",
  operationId: "startSlackInstall",
  summary: "Add to Slack",
  description:
    "For admins (INTEGRATION_MANAGE), in a browser: redirects to Slack to install the instance's Slack app into a " +
    "workspace, with a sealed, single-use state cookie that the callback checks. Lands back on Integrations.",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: {},
  errors: [401, 403, 404],
});
