import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const getFeedbackCommentPolicy = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/feedback/comment-policy",
  operationId: "getFeedbackCommentPolicy",
  summary: "Feedback comment marking policy",
  description:
    "For the feedback team on a government tenant: that comments can carry a classification marking, and the " +
    "org ceiling a marking is weighed against (CUI or above, beyond the ceiling, keeps a comment internal). " +
    "`marking` is null for commercial tenants and for anyone not on the feedback team.",
  tags: ["Feedback"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid }) },
  responses: {
    200: z.object({
      marking: z
        .object({ orgCeiling: z.enum(["PUBLIC", "UNCLASSIFIED", "FOUO", "CUI", "CONFIDENTIAL"]) })
        .nullable(),
    }),
  },
  errors: [401, 403, 404],
});
