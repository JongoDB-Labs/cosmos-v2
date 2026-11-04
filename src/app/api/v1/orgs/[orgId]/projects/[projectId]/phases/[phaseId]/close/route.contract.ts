import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const Phase = z.object({
  id: Uuid,
  name: z.string(),
  closedAt: z.string().nullable(),
  closedById: Uuid.nullable(),
  closeEvidenceNote: z.string().nullable(),
});

const params = z.object({ orgId: Uuid, projectId: Uuid, phaseId: Uuid });

export const closePhase = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/phases/{phaseId}/close",
  operationId: "closePhase",
  summary: "Close a phase",
  description:
    "Marks the phase closed. Under the org's closing rule it needs a supporting file attached to the phase, " +
    "or `closeEvidenceNote` (422 close_evidence_required otherwise), and a closed phase is read-only until reopened.",
  tags: ["Projects"],
  stability: "internal",
  // The bit it needs (PROJECT_UPDATE, via requireProjectManage) is one items:write keys already hold.
  scopes: ["items:write"],
  request: { params, body: z.object({ closeEvidenceNote: z.string().max(500).nullish() }) },
  responses: { 200: Phase },
  errors: [400, 401, 403, 404, 409, 422],
});
