import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { isRouteContract, type RouteContract } from "./contract";
import { pageQueryShape, NEXT_CURSOR_HEADER } from "./paginate";
import { Problem } from "./schemas/common";
import { API_VERSION, API_VERSION_HEADER } from "./version";

/**
 * Build the OpenAPI 3.1 document from the route contracts.
 *
 * `public` is what /developers shows and what openapi/cosmos-v1.json commits:
 * stable and beta operations. `internal` adds every `internal` contract, for
 * staff only, and is never committed.
 */
export type SpecAudience = "public" | "internal";

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "The request is malformed or fails validation (`invalid_request`).",
  401: "No valid credential (`unauthorized`).",
  403: "The credential lacks a scope or the user lacks a permission (`forbidden`, `insufficient_scope`).",
  404: "Not found, or not visible to this caller (`not_found`).",
  409: "Conflicts with the current state (`conflict`).",
  410: "The requested API version is no longer supported.",
  422: "The `Idempotency-Key` was already used for a different request (`idempotency_key_reused`).",
  429: "Rate limited (`rate_limited`); wait `Retry-After` seconds.",
};

const REQUEST_ID = {
  "X-Request-Id": {
    description: "This request's id. Echoed when you send one; quote it to support.",
    schema: { type: "string" as const },
  },
};

const VERSION_ECHO = {
  [API_VERSION_HEADER]: {
    description: `The version this request ran at, when it named one in \`${API_VERSION_HEADER}\`.`,
    schema: { type: "string" as const },
  },
};

const PAGE_HEADERS = {
  Link: {
    description: 'The next page, as `<url>; rel="next"`. Absent on the last page.',
    schema: { type: "string" as const },
  },
  [NEXT_CURSOR_HEADER]: {
    description: "The next page's cursor, for clients that don't parse `Link`.",
    schema: { type: "string" as const },
  },
};

function include(c: RouteContract, audience: SpecAudience): boolean {
  return audience === "internal" || c.stability !== "internal";
}

/** Contracts from the generated module list, in a stable order. */
export function collectContracts(modules: readonly Record<string, unknown>[]): RouteContract[] {
  const all = modules.flatMap((m) => Object.values(m).filter(isRouteContract));
  return all.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function register(registry: OpenAPIRegistry, c: RouteContract) {
  let query = c.request.query;
  if (c.pagination === "cursor") query = (query ?? z.object({})).extend(pageQueryShape);

  const responses: Record<string, unknown> = {};
  for (const [status, schema] of Object.entries(c.responses)) {
    const headers = { ...REQUEST_ID, ...VERSION_ECHO, ...(c.pagination ? PAGE_HEADERS : {}) };
    responses[status] = schema
      ? { description: c.summary, headers, content: { "application/json": { schema } } }
      : { description: c.summary, headers };
  }
  for (const status of c.errors) {
    responses[String(status)] = {
      description: ERROR_DESCRIPTIONS[status] ?? "Error",
      headers: REQUEST_ID,
      content: { "application/problem+json": { schema: Problem } },
    };
  }

  registry.registerPath({
    method: c.method,
    path: c.path,
    operationId: c.operationId,
    summary: c.summary,
    ...(c.description && { description: c.description }),
    tags: c.tags,
    security: [{ bearerPat: c.scopes }],
    parameters: [{ $ref: "#/components/parameters/ApiVersion" }],
    request: {
      ...(c.request.params && { params: c.request.params }),
      ...(query && { query }),
      ...(c.idempotency && {
        headers: z.object({
          "Idempotency-Key": z.string().min(1).max(255).optional().describe(
            "Any unique string (a UUID is ideal). Retrying with the same key and body within 24 hours " +
            "returns the first success instead of doing it again; the replay carries `Idempotent-Replayed: true`.",
          ),
        }),
      }),
      ...(c.request.body && {
        body: { required: true, content: { "application/json": { schema: c.request.body } } },
      }),
    },
    responses: responses as never,
    "x-cosmos-scopes": c.scopes,
    "x-cosmos-stability": c.stability,
    ...(c.sessionOnly && { "x-cosmos-session-only": c.sessionOnly }),
  });
}

export function buildDocument(contracts: RouteContract[], audience: SpecAudience) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "bearerPat", {
    type: "http",
    scheme: "bearer",
    description:
      "A Cosmos API key or personal access token: `Authorization: Bearer cosmos_<prefix>_<secret>`. " +
      "What it can do is its scopes intersected with its user's own permissions.",
  });
  registry.registerComponent("parameters", "ApiVersion", {
    name: API_VERSION_HEADER,
    in: "header",
    required: false,
    description:
      `The API version to run at (\`YYYY-MM-DD\`). Without it, a token runs at the version it was ` +
      `minted under and a browser session at the current one, ${API_VERSION}. ` +
      "An unknown version is a 400, a retired one a 410 (`unsupported_api_version`).",
    schema: { type: "string", example: API_VERSION },
  });
  for (const c of contracts) if (include(c, audience)) register(registry, c);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: audience === "public" ? "Cosmos API" : "Cosmos API (internal surface)",
      version: API_VERSION,
      description:
        "The Cosmos REST API. Guides, authentication and the changelog are at /developers.",
    },
    servers: [{ url: "/api/v1", description: "This Cosmos instance" }],
  });
}
