import { z } from "zod";
import { API_KEY_SCOPES } from "@/lib/auth/api-key-scopes";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { MintedToken, PersonalToken } from "@/lib/openapi/schemas/identity";

const SESSION_ONLY = " Browser session only: a token can never list or mint tokens.";

export const listMyTokens = defineRoute({
  method: "get",
  path: "/me/tokens",
  operationId: "listMyTokens",
  summary: "List my personal access tokens",
  description: "Your personal tokens, newest first." + SESSION_ONLY,
  tags: ["Account"],
  stability: "internal",
  scopes: [],
  request: { query: z.object({ orgId: Uuid.optional().describe("Only tokens for this organization.") }) },
  responses: { 200: z.array(PersonalToken) },
  errors: [400, 401, 403],
});

export const createMyToken = defineRoute({
  method: "post",
  path: "/me/tokens",
  operationId: "createMyToken",
  summary: "Create a personal access token",
  description:
    "A token that acts as you, in one organization, limited to its scopes (and optionally to some " +
    "projects). It always expires: at most 90 days, 30 in a government organization; 30 days when " +
    "`expiresIn` is omitted. The secret is returned once." + SESSION_ONLY,
  tags: ["Account"],
  stability: "internal",
  scopes: [],
  request: {
    body: z.object({
      orgId: Uuid,
      name: z.string().min(1).max(120),
      scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
      projectIds: z.array(z.string().uuid()).max(200).optional(),
      expiresIn: z.number().int().min(60).optional().describe("Lifetime in seconds."),
    }),
  },
  responses: { 201: MintedToken },
  errors: [400, 401, 403, 404],
});
