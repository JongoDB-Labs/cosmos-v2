import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { FeedbackStatus } from "@/lib/openapi/schemas/enums.generated";

// Merging duplicate feedback (feedback-discussion design, Phase 4). Internal:
// staff-only moderation from the board's own UI.

const params = z.object({ orgId: Uuid, feedbackId: Uuid });

export const mergeFeedbackItem = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/feedback/{feedbackId}/merge",
  operationId: "mergeFeedbackItem",
  summary: "Merge a feedback item into another",
  description:
    "Feedback team only. The item becomes MERGED and points at the survivor (resolved to the item that holds " +
    "the discussion); its voters and followers carry over. 409 when it would merge into itself, form a loop, " +
    "is already merged, or has others merged into it.",
  tags: ["Feedback"],
  stability: "internal",
  scopes: [],
  request: { params, body: z.object({ survivorId: Uuid }) },
  responses: { 200: z.object({ merged: z.literal(true), survivorId: Uuid }) },
  errors: [400, 401, 403, 404, 409],
});

export const unmergeFeedbackItem = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/feedback/{feedbackId}/merge",
  operationId: "unmergeFeedbackItem",
  summary: "Undo a feedback merge",
  description:
    "Feedback team only. Restores the item's status and votes; the survivor gives back exactly the votes and " +
    "followers the merge added.",
  tags: ["Feedback"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: z.object({ merged: z.literal(false), status: z.enum(FeedbackStatus) }) },
  errors: [401, 403, 404],
});
