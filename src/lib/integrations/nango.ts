// src/lib/integrations/nango.ts
//
// The in-boundary Nango client wrapper — COSMOS's single, org-scoped door to the
// self-hosted Nango unified-API engine (the OSS OAuth broker that carries the
// COMMERCIAL connector long-tail; ~180 providers). The Nango stack runs IN the
// compose network (see docker-compose.yml `nango` profile); this module talks to
// it server-side ONLY.
//
// ── D5 SECURITY INVARIANT (load-bearing) ───────────────────────────────────────
// Nango is COMMERCIAL-ONLY breadth. This wrapper is plumbing; it carries NO tenant
// class itself and must therefore NEVER be reached on a gov path. The gov-block is
// enforced in DEPTH upstream (tool-list filter, dispatch refusal, the Nango
// executor's hard `tenantClass !== "gov"` check, and the connect route's 403). This
// file is the LAST hop before Nango and assumes the caller already proved commercial.
//
// ── Secret handling (SC-28 / IA-5) ─────────────────────────────────────────────
// `NANGO_SECRET_KEY` is a PLATFORM secret (the self-hosted Nango environment's API
// secret key), injected via env / Docker secret — NOT a per-tenant DB-stored cred,
// so it needs no field-seal. It is read at call time, NEVER logged, and NEVER
// returned to a client or the model. `NANGO_HOST` is the internal compose URL
// (http://nango-server:3003). When either is unset the wrapper is DISABLED
// (`nangoEnabled()` is false) — the connector degrades to a graceful "not
// configured" rather than crashing a base `up` that didn't start the nango profile.
//
// ── Org-scoped connection ids (multi-tenant isolation) ──────────────────────────
// Every Nango connection is addressed by a connection id we DERIVE from the org id
// (+ provider): `<orgId>` or `<orgId>:<provider>`. One org can never name another
// org's connection — the id is built here, not taken from the caller. This mirrors
// the org-scoped sealed-credential rule in credentials.ts (no cross-tenant read).

import { Nango } from "@nangohq/node";

/** A provider config key (Nango "integration id") — the per-provider config slug. */
export type NangoProvider = string;

/**
 * Is the Nango integration configured (and therefore usable)? OFF when either the
 * platform secret key or the internal host URL is unset — so a base `up` without the
 * `nango` profile, or a deploy that hasn't provisioned Nango, degrades gracefully
 * instead of throwing. Read at CALL TIME (never memoized) so tests/deploys see the
 * current env. NEVER logs the key.
 */
export function nangoEnabled(): boolean {
  return Boolean(process.env.NANGO_SECRET_KEY && process.env.NANGO_HOST);
}

/**
 * Build the org-scoped connection id for (orgId[, provider]). The id is DERIVED
 * from the org — a caller can only ever address ITS OWN org's connection. When a
 * provider is given we namespace per provider (`<orgId>:<provider>`) so one org can
 * hold connections to several providers; the bare `<orgId>` form is available for a
 * single-connection-per-org model. Both are deterministic and collision-free across
 * orgs (the org id is a uuid).
 */
export function nangoConnectionId(orgId: string, provider?: NangoProvider): string {
  if (!orgId) throw new Error("[nango] orgId is required to derive a connection id");
  return provider ? `${orgId}:${provider}` : orgId;
}

/**
 * Construct the Nango SDK client pointed at the IN-BOUNDARY self-hosted server.
 * Throws (loudly) when unconfigured — every public helper guards with
 * `nangoEnabled()` first and returns a graceful shape, so this throw only ever
 * surfaces as a programming error (calling a raw client builder while disabled).
 * The secret key is passed to the SDK in-process and never logged.
 */
function client(): Nango {
  const secretKey = process.env.NANGO_SECRET_KEY;
  const host = process.env.NANGO_HOST;
  if (!secretKey || !host) {
    // Message names NO secret material — just which env vars are missing.
    throw new Error(
      "[nango] not configured: set NANGO_SECRET_KEY and NANGO_HOST (the in-boundary Nango server URL).",
    );
  }
  return new Nango({ secretKey, host });
}

/** A graceful "Nango not configured" result the connector layer can surface to the model. */
const NOT_CONFIGURED = {
  error:
    "The unified-connector engine (Nango) is not configured for this deployment. An operator must start the `nango` compose profile and set NANGO_SECRET_KEY / NANGO_HOST.",
} as const;

/**
 * Create a Connect session for (orgId, provider). Returns the session token the
 * frontend Connect UI uses to run the OAuth (or API-key) grant for THIS org. The
 * connection it creates is bound to the org-scoped connection id so the resulting
 * grant is addressable only as this org's. `tags` carry the org id for Nango-side
 * correlation (non-secret).
 */
export async function createConnectSession(
  orgId: string,
  provider: NangoProvider,
): Promise<unknown> {
  if (!nangoEnabled()) return NOT_CONFIGURED;
  const nango = client();
  return nango.createConnectSession({
    // Bind the end user / org so Nango records WHO the connection is for. The
    // connection id COSMOS later reads/proxies under is the org-scoped id below.
    end_user: { id: nangoConnectionId(orgId, provider), tags: { organization_id: orgId } },
    allowed_integrations: [provider],
  });
}

/**
 * List the Nango connections for THIS org. Scoped by the org-derived connection id
 * (search) so it never returns another org's connections. Returns a graceful shape
 * when Nango is unconfigured.
 */
export async function listConnections(orgId: string): Promise<unknown> {
  if (!nangoEnabled()) return NOT_CONFIGURED;
  const nango = client();
  // The org id is the stable prefix of every connection id we mint for this org
  // (`<orgId>` or `<orgId>:<provider>`), so searching by it returns ONLY this org's.
  // Positional overload: listConnections(connectionId?, search?) — pass `search`.
  return nango.listConnections(undefined, orgId);
}

/**
 * Get a single connection for (orgId, provider), or a graceful "not connected"
 * error when the org hasn't completed a grant for that provider. The credential
 * material in the returned object is for IMMEDIATE server-side use only — callers
 * must NOT echo it to a client or the model (the connector executor returns only
 * proxied API data, never the raw credentials).
 */
export async function getConnection(
  orgId: string,
  provider: NangoProvider,
): Promise<unknown> {
  if (!nangoEnabled()) return NOT_CONFIGURED;
  const nango = client();
  try {
    return await nango.getConnection(provider, nangoConnectionId(orgId, provider));
  } catch {
    // A 404 (no such connection) → graceful "not connected", mirroring the
    // GitHub/Google connector pattern. We DON'T surface the raw SDK error (it could
    // include the host / request detail); just a clean, secret-free message.
    return { error: `Not connected: this organization has no ${provider} connection. Connect it first.` };
  }
}

/**
 * Get the live access token (auto-refreshed by Nango) for (orgId, provider). For
 * the rare case a caller needs the raw token rather than the proxy. The token is
 * for IMMEDIATE server-side use — NEVER logged, NEVER returned to a client/model.
 */
export async function getNangoToken(
  orgId: string,
  provider: NangoProvider,
): Promise<string | null> {
  if (!nangoEnabled()) return null;
  const nango = client();
  try {
    const tok = await nango.getToken(provider, nangoConnectionId(orgId, provider));
    return typeof tok === "string" ? tok : null;
  } catch {
    return null;
  }
}

/** The HTTP verb a Nango proxy call may use. */
export type NangoMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface NangoProxyRequest {
  method?: NangoMethod;
  /** The provider-relative endpoint path, e.g. "/v3/contacts". */
  endpoint: string;
  /** Query params (the values Nango's proxy accepts: strings/numbers + their arrays). */
  params?: Record<string, string | number | string[] | number[]>;
  /** Request body (for write verbs). */
  data?: unknown;
  /** Extra headers (NEVER put a secret here — Nango injects the auth from the connection). */
  headers?: Record<string, string>;
}

/**
 * Proxy an API request to `provider` THROUGH Nango on behalf of THIS org. Nango
 * injects the org's connection credentials server-side (we never see/pass the
 * token), so this carries data ONLY — no secret material crosses this boundary in
 * either direction. Returns the proxied response body (`data`) on success, or a
 * graceful, secret-free `{ error }` when unconfigured / not connected / the upstream
 * API errors.
 *
 * The connection id is the ORG-SCOPED id — a call can only ever act as this org's
 * connection, never another org's.
 */
export async function nangoProxy(
  orgId: string,
  provider: NangoProvider,
  req: NangoProxyRequest,
): Promise<unknown> {
  if (!nangoEnabled()) return NOT_CONFIGURED;
  const nango = client();
  try {
    const res = await nango.proxy({
      method: req.method ?? "GET",
      endpoint: req.endpoint,
      providerConfigKey: provider,
      connectionId: nangoConnectionId(orgId, provider),
      params: req.params,
      data: req.data,
      headers: req.headers,
    });
    // Return ONLY the response body — never the axios wrapper (which can echo
    // request config incl. headers). Nango proxies data, not our secret key.
    return { success: true, status: res.status, data: res.data };
  } catch (err) {
    // Secret-free error. Prefer the upstream HTTP status when present; otherwise a
    // generic message. NEVER interpolate the error object wholesale (it can carry
    // the request config / headers).
    const status =
      (err as { response?: { status?: number } })?.response?.status ??
      (err as { status?: number })?.status;
    if (status === 404) {
      return { error: `Not connected: this organization has no ${provider} connection, or the endpoint was not found.` };
    }
    return { error: `Nango proxy request to ${provider} failed${status ? ` (HTTP ${status})` : ""}.` };
  }
}
