// src/lib/ai/executors/nango.ts
//
// Nango connector EXECUTOR — the COMMERCIAL-ONLY unified-API path. It routes the
// agent's Nango tool calls through the in-boundary Nango client wrapper
// (src/lib/integrations/nango.ts), ORG-SCOPED (every call acts only as the caller's
// org connection — the connection id is derived from orgId, never the caller).
//
// ── D5 GOV-BLOCK, LAYER 3 (the executor's own hard gate) ────────────────────────
// This is the LAST in-code layer before the broker. Even though a gov tenant's model
// never sees these tools (L1) and dispatch refuses them (L2), the executor ALSO
// hard-checks `tenantClass !== "gov"` at the TOP of every entry and refuses
// otherwise — defense in depth: if any future caller reached here for a gov tenant,
// the broker is still never touched. The refusal returns a graceful (model-safe)
// error AND is audited via the registry's L2 path for any normal call; this layer is
// the backstop for a DIRECT executor call (e.g. a test/forged invocation) that
// bypassed the registry.
//
// ── Egress ─────────────────────────────────────────────────────────────────────
// Nango tool results have NO per-entity egress mapping (commercial-only; the gov case
// is blocked anyway). For a commercial tenant (below FOUO) they flow FULL; the
// marking-DLP tripwire in the chokepoint still applies. The executor returns proxied
// API data + structural connection metadata ONLY — never the secret key or raw creds.

import {
  nangoEnabled,
  listConnections,
  getConnection,
  nangoProxy,
  type NangoMethod,
} from "@/lib/integrations/nango";
import type { ConnectorToolContext } from "../connectors/types";

type ToolArgs = Record<string, unknown>;

/** The model-safe refusal returned if a gov tenant ever reaches this executor (L3). */
const GOV_REFUSAL = {
  error:
    "This connector (Nango unified-API breadth) is commercial-only and is not available to this tenant.",
} as const;

const NOT_CONFIGURED = {
  error:
    "The unified-connector engine (Nango) is not configured for this deployment.",
} as const;

/** Coerce an arg to a non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Normalize a method arg to a supported verb (default GET). */
function method(v: unknown): NangoMethod {
  const up = typeof v === "string" ? v.toUpperCase() : "GET";
  return up === "POST" || up === "PUT" || up === "PATCH" || up === "DELETE" ? (up as NangoMethod) : "GET";
}

/**
 * Dispatch a Nango tool call. Returns `null` if `name` is not a Nango tool (so a
 * parent dispatcher could fall through — though the registry only ever calls this for
 * names this connector owns). EVERY branch enforces the L3 gov hard-check FIRST.
 */
export async function executeNangoTool(
  name: string,
  args: ToolArgs,
  ctx: ConnectorToolContext,
): Promise<unknown | null> {
  if (!NANGO_TOOL_NAMES.has(name)) return null;

  // ── L3: gov hard-refusal, BEFORE any wrapper call ──────────────────────────────
  // Fail closed: refuse for gov OR an absent class (the registry threads commercial
  // through for a legit commercial call; absence here means a non-tenant-scoped
  // direct call, which must not reach the broker).
  if (ctx.tenantClass !== "commercial") {
    return GOV_REFUSAL;
  }

  if (!nangoEnabled()) return NOT_CONFIGURED;

  switch (name) {
    case "nango_list_connections":
      // The org's connected providers (structural metadata) — never the creds.
      return listConnections(ctx.orgId);

    case "nango_get_connection": {
      const provider = str(args.provider);
      if (!provider) return { error: "provider is required (the Nango integration id, e.g. 'hubspot')." };
      return getConnection(ctx.orgId, provider);
    }

    case "nango_proxy_request": {
      const provider = str(args.provider);
      const endpoint = str(args.endpoint);
      if (!provider) return { error: "provider is required (the Nango integration id, e.g. 'hubspot')." };
      if (!endpoint) return { error: "endpoint is required (the provider-relative API path, e.g. '/v3/objects/contacts')." };
      // params is an optional flat string/number map; pass it through (the wrapper
      // narrows the type). data is for write verbs.
      const params =
        args.params && typeof args.params === "object" && !Array.isArray(args.params)
          ? (args.params as Record<string, string | number | string[] | number[]>)
          : undefined;
      return nangoProxy(ctx.orgId, provider, {
        method: method(args.method),
        endpoint,
        params,
        data: args.data,
      });
    }

    default:
      return null;
  }
}

/** Names of all Nango tools — for O(1) membership + the registry's tool-name set. */
export const NANGO_TOOL_NAMES: ReadonlySet<string> = new Set([
  "nango_list_connections",
  "nango_get_connection",
  "nango_proxy_request",
]);
