import { defineRoute } from "@/lib/openapi/contract";
import { Me } from "@/lib/openapi/schemas/identity";

export const getMe = defineRoute({
  method: "get",
  path: "/me",
  operationId: "getMe",
  summary: "Who am I",
  description: "The signed-in user, or the user a token acts as (with the token's org and scopes).",
  tags: ["Account"],
  stability: "stable",
  scopes: [],
  request: {},
  responses: { 200: Me },
  errors: [401, 404],
});
