import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const updateSlackLink = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/slack/links/{linkId}",
  operationId: "updateSlackLink",
  summary: "Approve or remove a member's Slack link",
  description:
    "For admins (INTEGRATION_MANAGE): `approve` lets a member who shares a Slack account with another member get " +
    "messages too; `unlink` removes a member's link (they aren't matched again automatically). An admin can't " +
    "approve their own link (403).",
  tags: ["Integrations"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, linkId: Uuid }), body: z.strictObject({ action: z.enum(["approve", "unlink"]) }) },
  responses: { 200: z.object({ ok: z.literal(true) }) },
  errors: [400, 401, 403, 404, 409],
});
