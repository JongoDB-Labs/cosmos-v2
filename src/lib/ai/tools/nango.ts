import type { ToolDefinition } from "../tools";

/**
 * Nango tool catalog — the COMMERCIAL-ONLY unified-API breadth path. These tools let
 * the assistant read/act against ~180 commercial SaaS providers THROUGH the
 * in-boundary self-hosted Nango broker (OAuth/API-key creds are held by Nango,
 * org-scoped; COSMOS never sees the token). Executors live in
 * `src/lib/ai/executors/nango.ts`; wired via the connector registry
 * (`connectors/nango.descriptor.ts`, availability: "commercial-only").
 *
 * D5: these tools are NEVER offered to a gov tenant (the connector registry's
 * tenant-filtered tool list excludes them; dispatch + the executor also hard-refuse).
 * They appear in a COMMERCIAL tenant's tool list only.
 *
 * A generic `nango_proxy_request` carries the breadth (any provider/endpoint the org
 * has connected); `nango_list_connections` / `nango_get_connection` report what the
 * org has connected so the assistant can degrade gracefully ("not connected").
 */
export const nangoTools: ToolDefinition[] = [
  {
    name: "nango_list_connections",
    description:
      "List the external SaaS providers this organization has connected via Nango (the unified-connector engine). Returns structural connection metadata (which providers are connected) — never credentials. Use this to discover what nango_proxy_request can reach.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "nango_get_connection",
    description:
      "Check whether this organization has a Nango connection for a specific provider, returning its structural connection metadata (never credentials). Returns a 'not connected' message if the provider hasn't been connected.",
    input_schema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "The Nango integration id / provider config key (e.g. 'hubspot', 'salesforce', 'notion').",
        },
      },
      required: ["provider"],
    },
  },
  {
    name: "nango_proxy_request",
    description:
      "Make an API request to a connected SaaS provider THROUGH Nango on behalf of this organization. Nango injects the org's stored credentials server-side (you never handle the token). Use the provider's own REST endpoints and parameters. Returns the upstream response body. Returns a 'not connected' message if the org hasn't connected that provider.",
    input_schema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "The Nango integration id / provider config key (e.g. 'hubspot', 'salesforce', 'notion').",
        },
        endpoint: {
          type: "string",
          description:
            "The provider-relative API path, e.g. '/v3/objects/contacts' or '/crm/v3/owners'.",
        },
        method: {
          type: "string",
          description: "HTTP method: GET (default), POST, PUT, PATCH, or DELETE.",
        },
        params: {
          type: "object",
          description:
            "Optional query parameters as a flat object of string/number values (e.g. { limit: 10 }).",
        },
        data: {
          type: "object",
          description: "Optional request body for write methods (POST/PUT/PATCH).",
        },
      },
      required: ["provider", "endpoint"],
    },
  },
];
