import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { ProjectUnbilledReimbursables, UnbilledReimbursableItem } from "@/lib/openapi/schemas/unbilled";

export const listProjectUnbilledReimbursables = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/unbilled-reimbursables",
  operationId: "listProjectUnbilledReimbursables",
  summary: "A project's unbilled reimbursable costs",
  description:
    "The per-project form of listUnbilledReimbursables: the same items and totals for one project, with empty items and zero totals when nothing is unbilled. Needs finance-read on a project the caller can see.",
  tags: ["Finance"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid }) },
  responses: {
    200: ProjectUnbilledReimbursables.extend({ items: z.array(UnbilledReimbursableItem), lines: z.enum(["one", "two"]) }),
  },
  errors: [400, 401, 403, 404],
});
