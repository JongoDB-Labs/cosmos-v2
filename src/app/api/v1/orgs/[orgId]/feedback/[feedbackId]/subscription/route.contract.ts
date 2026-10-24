import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Following a feedback item (feedback-discussion design, Phase 3). Internal:
// the board's own UI is its only caller.

const params = z.object({ orgId: Uuid, feedbackId: Uuid });
const following = z.object({ following: z.boolean() });

export const getFeedbackSubscription = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/feedback/{feedbackId}/subscription",
  operationId: "getFeedbackSubscription",
  summary: "Whether you follow a feedback item",
  description: "Followers hear about new comments and status changes on the item.",
  tags: ["Feedback"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: following },
  errors: [401, 403, 404],
});

export const setFeedbackSubscription = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/feedback/{feedbackId}/subscription",
  operationId: "setFeedbackSubscription",
  summary: "Follow or unfollow a feedback item",
  description: "Unfollowing is remembered: being mentioned or voting later doesn't sign you back up.",
  tags: ["Feedback"],
  stability: "internal",
  scopes: [],
  request: { params, body: following },
  responses: { 200: following },
  errors: [400, 401, 403, 404],
});
