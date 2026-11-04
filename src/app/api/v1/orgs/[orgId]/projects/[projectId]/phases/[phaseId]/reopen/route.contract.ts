import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { Phase } from "../close/route.contract";

const params = z.object({ orgId: Uuid, projectId: Uuid, phaseId: Uuid });

export const reopenPhase = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/phases/{phaseId}/reopen",
  operationId: "reopenPhase",
  summary: "Reopen a closed phase",
  tags: ["Projects"],
  stability: "internal",
  // The bit it needs (PROJECT_UPDATE, via requireProjectManage) is one items:write keys already hold.
  scopes: ["items:write"],
  request: { params },
  responses: { 200: Phase },
  errors: [400, 401, 403, 404, 409],
});
