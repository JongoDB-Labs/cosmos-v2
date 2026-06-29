/**
 * Microsoft Graph — org-app (client-credentials) token exchange + cache.
 *
 * The NEW wrinkle vs the static-bearer/basic connectors (GitHub PAT / Jira email+token /
 * Slack xoxb-): Microsoft Graph app-only auth requires an OAuth2 **client-credentials**
 * grant — the org's sealed Entra app credential (`{ clientId, clientSecret, tenantId }`)
 * is exchanged at the cloud-correct Entra authority for a short-lived (≈1h) access token,
 * which is then presented to Graph. This module owns that exchange + a per-org in-memory
 * cache so we don't re-exchange on every Graph call.
 *
 * ── Credential split (v2.7/v2.8 sealed-install path) ──────────────────────────────────
 *   - SEALED bundle  (vault, `getOrgCredential(orgId,'microsoft365')`): the Entra app
 *     creds `{ clientId, clientSecret, tenantId }`. `clientSecret` is the configField
 *     marked `secret:true`; clientId/tenantId are also sealed in the bundle (the install
 *     route seals every secret:true field; here all three are sealed so the whole app
 *     identity stays out of plaintext config — see catalog configFields).
 *   - NON-SECRET config (`Integration.config`, plaintext): `{ cloud }` — `commercial`
 *     (default) or `gov` (GCC-High / Azure Government). This picks the authority + scope
 *     + Graph base URL below.
 *
 * ── Cloud toggle (commercial vs GCC-High) ────────────────────────────────────────────
 *   commercial: authority https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
 *               scope     https://graph.microsoft.com/.default
 *               base      https://graph.microsoft.com/v1.0
 *   gov:        authority https://login.microsoftonline.us/<tenant>/oauth2/v2.0/token
 *               scope     https://graph.microsoft.us/.default
 *               base      https://graph.microsoft.us/v1.0
 *
 * ── INVARIANTS (gov / no-secret-or-token-leak) ───────────────────────────────────────
 *   - The clientSecret and the minted access token are NEVER logged and NEVER returned
 *     to the model. `getGraphToken` returns `{ accessToken, graphBaseUrl }` for immediate
 *     server-side use by `graphFetch`; the executor strips the token before any result is
 *     surfaced (the egress chokepoint is the final floor on what the model sees).
 *   - `fetch` is INJECTABLE (`{ fetchImpl }`) so tests mock BOTH the token endpoint AND
 *     Graph without a network.
 *   - Missing/incomplete sealed credential ⇒ a graceful "not connected" error, never a
 *     throw (mirrors the GitHub/Jira/Slack pattern).
 */

import { getOrgCredential } from "@/lib/integrations/credentials";
import { prisma } from "@/lib/db/client";

/** Minimal fetch signature we depend on — lets tests inject a mock (no network). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** The cloud the org's M365 tenant lives in — drives authority/scope/base. */
export type GraphCloud = "commercial" | "gov";

/** The per-cloud Entra/Graph endpoints. Centralized so the toggle is one source of truth. */
interface CloudEndpoints {
  /** Entra authority host (token endpoint host). */
  authorityHost: string;
  /** The client-credentials scope (`<resource>/.default`). */
  scope: string;
  /** Graph REST base URL (versioned). */
  graphBaseUrl: string;
}

function endpointsFor(cloud: GraphCloud): CloudEndpoints {
  if (cloud === "gov") {
    // GCC-High / Azure Government.
    return {
      authorityHost: "login.microsoftonline.us",
      scope: "https://graph.microsoft.us/.default",
      graphBaseUrl: "https://graph.microsoft.us/v1.0",
    };
  }
  // Commercial (default).
  return {
    authorityHost: "login.microsoftonline.com",
    scope: "https://graph.microsoft.com/.default",
    graphBaseUrl: "https://graph.microsoft.com/v1.0",
  };
}

const NOT_CONNECTED =
  "Microsoft 365 is not connected for this organization. Ask an admin to install the Microsoft 365 integration (Entra app clientId + clientSecret + tenantId; cloud: commercial or gov) on the Integrations page.";

interface GraphAccess {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  cloud: GraphCloud;
}

/** Resolve the org's sealed Entra app credential + non-secret `cloud`, or a graceful error. */
async function resolveGraphAccess(
  orgId: string,
): Promise<{ error: string } | GraphAccess> {
  // The sealed bundle holds the Entra app identity { clientId, clientSecret, tenantId }.
  const bundle = await getOrgCredential(orgId, "microsoft365");
  if (!bundle || !bundle.clientId || !bundle.clientSecret || !bundle.tenantId) {
    return { error: NOT_CONNECTED };
  }
  // Non-secret config (cloud) lives in Integration.config; default to commercial.
  const integration = await prisma.integration.findFirst({
    where: { orgId, provider: "microsoft365" },
    select: { config: true },
  });
  const config = (integration?.config ?? {}) as Record<string, unknown>;
  const cloud: GraphCloud = config.cloud === "gov" ? "gov" : "commercial";
  return {
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    tenantId: bundle.tenantId,
    cloud,
  };
}

/** A cached access token for an org (the minted token + its absolute expiry epoch-ms). */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Per-ORG token cache, keyed by `${orgId}:${cloud}` so a re-install that flips the cloud
 * never serves a stale cross-cloud token. In-memory / per-process (the same shape as the
 * DocuSign per-process cache) — tokens are short-lived and never persisted.
 */
const tokenCache = new Map<string, CachedToken>();

/** Refresh ~5 minutes BEFORE the real expiry so an in-flight Graph call never 401s. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** TEST-ONLY: clear the per-org token cache so a unit test starts clean. */
export function _resetGraphTokenCache(): void {
  tokenCache.clear();
}

/** The successful result of {@link getGraphToken} — token (server-side use only) + base URL. */
export interface GraphTokenResult {
  accessToken: string;
  graphBaseUrl: string;
  cloud: GraphCloud;
}

/**
 * Resolve a valid Graph access token for the org, performing a client-credentials
 * exchange against the cloud-correct Entra authority when the cache is cold/expired.
 *
 * Returns `{ accessToken, graphBaseUrl, cloud }` on success, or `{ error }` when the org
 * has no M365 credential (graceful "not connected") or the token endpoint refuses the
 * exchange. NEVER logs the clientSecret or the token; NEVER returns the secret.
 */
export async function getGraphToken(
  orgId: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<GraphTokenResult | { error: string }> {
  const access = await resolveGraphAccess(orgId);
  if ("error" in access) return access;

  const { authorityHost, scope, graphBaseUrl } = endpointsFor(access.cloud);
  const cacheKey = `${orgId}:${access.cloud}`;

  // Serve a cached token while it is still comfortably valid (refresh-skew applied).
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt - REFRESH_SKEW_MS > now) {
    return { accessToken: cached.token, graphBaseUrl, cloud: access.cloud };
  }

  // Cold/expired ⇒ exchange the sealed app creds for a fresh token.
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const tokenUrl = `https://${authorityHost}/${encodeURIComponent(access.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: access.clientId,
    client_secret: access.clientSecret,
    scope,
  }).toString();

  let res;
  try {
    res = await doFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    // Transport failure — surface a clean, secret-free error (never echo the body/creds).
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Microsoft Graph token exchange failed: ${msg}` };
  }

  if (!res.ok) {
    // Surface only the HTTP status + AADSTS error code (NEVER the request body/secret).
    let code = "";
    try {
      const parsed = (await res.json()) as { error?: unknown; error_description?: unknown };
      if (typeof parsed?.error === "string") code = `: ${parsed.error}`;
    } catch {
      /* body not JSON — ignore (do NOT echo it; it could carry request context) */
    }
    return { error: `Microsoft Graph token exchange error (HTTP ${res.status})${code}` };
  }

  const json = (await res.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (!token) {
    return { error: "Microsoft Graph token exchange returned no access_token" };
  }
  // expires_in is seconds; default to 3600 (Entra's typical app-token lifetime) if absent.
  const expiresInSec =
    typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + expiresInSec * 1000,
  });

  return { accessToken: token, graphBaseUrl, cloud: access.cloud };
}

/** A successful Graph response payload, or a graceful, token-free error. */
export type GraphFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Issue a GET against Microsoft Graph for the org, minting/refreshing the access token
 * as needed. `path` is appended to the cloud-correct Graph base URL (e.g. `/users` or
 * `/users/{id}/messages?$top=20`). The Bearer token is sent to Graph but NEVER returned
 * or logged. A "not connected" org, a token-exchange failure, or a Graph 4xx/5xx all map
 * to a graceful `{ ok:false, error }` — the caller's executor never throws.
 */
export async function graphFetch(
  orgId: string,
  path: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<GraphFetchResult> {
  const tok = await getGraphToken(orgId, opts);
  if ("error" in tok) return { ok: false, error: tok.error };

  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${tok.graphBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  let res;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tok.accessToken}`,
        Accept: "application/json",
        "User-Agent": "cosmos-connector",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Microsoft Graph request failed: ${msg}` };
  }

  if (!res.ok) {
    // Surface a clean, token-free error. Graph wraps errors as { error: { code, message } }.
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      const code = parsed?.error?.code;
      if (typeof code === "string") detail = `: ${code}`;
    } catch {
      /* body not JSON — ignore */
    }
    return { ok: false, error: `Microsoft Graph API error (HTTP ${res.status})${detail}` };
  }

  return { ok: true, data: await res.json() };
}

/**
 * Upload (PUT) a binary file to Microsoft Graph for the org — e.g. mirror an
 * export to a SharePoint document library. `uploadPath` is appended to the
 * cloud-correct Graph base URL, e.g.
 *   /sites/{siteId}/drives/{driveId}/root:/{folder}/{name}.xlsx:/content
 * Uses the real `fetch` (binary body); the Bearer token is sent but never
 * returned/logged. A not-connected org, token failure, or Graph 4xx/5xx all map
 * to a graceful `{ ok:false, error }`. Requires the Entra app to hold
 * `Sites.ReadWrite.All` (or `Sites.Selected`) + admin consent.
 */
export async function graphUploadFile(
  orgId: string,
  uploadPath: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<GraphFetchResult> {
  const tok = await getGraphToken(orgId);
  if ("error" in tok) return { ok: false, error: tok.error };

  const url = `${tok.graphBaseUrl}${uploadPath.startsWith("/") ? uploadPath : `/${uploadPath}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tok.accessToken}`,
        "Content-Type": contentType,
        "User-Agent": "cosmos-connector",
      },
      body: content,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Microsoft Graph upload failed: ${msg}` };
  }

  if (!res.ok) {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: { code?: unknown } };
      if (typeof parsed?.error?.code === "string") detail = `: ${parsed.error.code}`;
    } catch {
      /* body not JSON — ignore */
    }
    return { ok: false, error: `Microsoft Graph upload error (HTTP ${res.status})${detail}` };
  }

  return { ok: true, data: await res.json() };
}

/** The bytes of a downloaded file, or a graceful error. */
export type GraphDownloadResult =
  | { ok: true; content: ArrayBuffer; contentType: string | null }
  | { ok: false; error: string };

/**
 * Download a file's raw bytes from Microsoft Graph for the org — the read half
 * of the SharePoint round-trip (e.g. pull an existing tracker workbook to ingest
 * it). `downloadPath` resolves against the Graph base URL, e.g.
 *   /sites/{siteId}/drives/{driveId}/root:/{folder}/{name}.xlsx:/content
 * The full import / in-place-update flows (parse + upsert, or the workbook range
 * PATCH API) build on this primitive and are validated once an Entra app exists.
 */
export async function graphDownloadFile(
  orgId: string,
  downloadPath: string,
): Promise<GraphDownloadResult> {
  const tok = await getGraphToken(orgId);
  if ("error" in tok) return { ok: false, error: tok.error };

  const url = `${tok.graphBaseUrl}${downloadPath.startsWith("/") ? downloadPath : `/${downloadPath}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${tok.accessToken}`, "User-Agent": "cosmos-connector" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Microsoft Graph download failed: ${msg}` };
  }

  if (!res.ok) {
    return { ok: false, error: `Microsoft Graph download error (HTTP ${res.status})` };
  }
  return {
    ok: true,
    content: await res.arrayBuffer(),
    contentType: res.headers.get("content-type"),
  };
}
