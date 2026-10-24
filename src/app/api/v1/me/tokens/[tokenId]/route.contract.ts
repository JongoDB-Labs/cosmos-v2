import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const revokeMyToken = defineRoute({
  method: "delete",
  path: "/me/tokens/{tokenId}",
  operationId: "revokeMyToken",
  summary: "Revoke a personal access token",
  description: "Takes effect immediately. Browser session only.",
  tags: ["Account"],
  stability: "internal",
  scopes: [],
  request: { params: z.object({ tokenId: Uuid }) },
  responses: { 204: null },
  errors: [400, 401, 403, 404],
});
