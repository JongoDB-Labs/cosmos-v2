import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

export const getOpenApiDocument = defineRoute({
  method: "get",
  path: "/openapi.json",
  operationId: "getOpenApiDocument",
  summary: "The OpenAPI description of this API",
  description: "The OpenAPI 3.1 document /developers renders.",
  tags: ["Meta"],
  // Not in the document it serves: describing the spec in the spec helps no one.
  stability: "internal",
  scopes: [],
  request: {},
  responses: {
    200: z.looseObject({ openapi: z.string(), info: z.looseObject({}), paths: z.looseObject({}) })
      .meta({ id: "OpenApiDocument" }),
  },
  errors: [401],
});
