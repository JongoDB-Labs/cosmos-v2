/**
 * Microsoft Teams — post a channel message via Microsoft Graph (FR 8a162fe7).
 *
 * Self-contained client-credentials flow mirroring microsoft-graph.ts, but keyed
 * to the org's own `microsoft-teams-messaging` sealed credential so Teams can be
 * configured independently of the Microsoft 365 connector. The Entra app
 * `{ clientId, clientSecret, tenantId }` is sealed (vault); the non-secret
 * `{ cloud, defaultTeamId, defaultChannelId }` lives in Integration.config.
 *
 * INVARIANTS: the client secret and minted token are NEVER logged or returned.
 * `fetch` is injectable for tests. A missing/incomplete credential is a graceful
 * error, never a throw.
 */

import { getOrgCredential } from "@/lib/integrations/credentials";
import { prisma } from "@/lib/db/client";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

const PROVIDER = "microsoft-teams-messaging";

const NOT_CONNECTED =
  "Microsoft Teams is not connected for this organization. Ask an admin to install the Microsoft Teams integration (Entra app clientId + clientSecret + tenantId) on the Integrations page.";

type Cloud = "commercial" | "gov";

interface TeamsConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  cloud: Cloud;
  defaultTeamId?: string;
  defaultChannelId?: string;
}

function endpointsFor(cloud: Cloud) {
  if (cloud === "gov") {
    return {
      authorityHost: "login.microsoftonline.us",
      scope: "https://graph.microsoft.us/.default",
      graphBaseUrl: "https://graph.microsoft.us/v1.0",
    };
  }
  return {
    authorityHost: "login.microsoftonline.com",
    scope: "https://graph.microsoft.com/.default",
    graphBaseUrl: "https://graph.microsoft.com/v1.0",
  };
}

/** Resolve the org's sealed Entra app credential + non-secret Teams config. */
async function resolveConfig(orgId: string): Promise<{ error: string } | TeamsConfig> {
  const bundle = await getOrgCredential(orgId, PROVIDER);
  if (!bundle || !bundle.clientId || !bundle.clientSecret || !bundle.tenantId) {
    return { error: NOT_CONNECTED };
  }
  const integration = await prisma.integration.findFirst({
    where: { orgId, provider: PROVIDER },
    select: { config: true },
  });
  const config = (integration?.config ?? {}) as Record<string, unknown>;
  return {
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    tenantId: bundle.tenantId,
    cloud: config.cloud === "gov" ? "gov" : "commercial",
    defaultTeamId: typeof config.defaultTeamId === "string" ? config.defaultTeamId : undefined,
    defaultChannelId:
      typeof config.defaultChannelId === "string" ? config.defaultChannelId : undefined,
  };
}

/** Exchange the sealed app creds for a short-lived Graph token (no cache — Teams
 *  posts are low-frequency). Returns the token + the cloud-correct Graph base. */
async function mintToken(
  cfg: TeamsConfig,
  fetchImpl: FetchLike,
): Promise<{ token: string; graphBaseUrl: string } | { error: string }> {
  const { authorityHost, scope, graphBaseUrl } = endpointsFor(cfg.cloud);
  const tokenUrl = `https://${authorityHost}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope,
  }).toString();

  let res;
  try {
    res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    return { error: `Teams token exchange failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    let code = "";
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (typeof parsed?.error === "string") code = `: ${parsed.error}`;
    } catch {
      /* body not JSON */
    }
    return { error: `Teams token exchange error (HTTP ${res.status})${code}` };
  }
  const json = (await res.json()) as { access_token?: unknown };
  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (!token) return { error: "Teams token exchange returned no access_token" };
  return { token, graphBaseUrl };
}

export type TeamsResult = { ok: true } | { ok: false; error: string };

/**
 * Post an HTML message to a Teams channel. `teamId`/`channelId` default to the
 * configured defaults; pass them to target another channel. Returns a graceful
 * error (never throws / leaks the token).
 */
export async function postTeamsChannelMessage(
  orgId: string,
  message: { html: string; teamId?: string; channelId?: string },
  opts: { fetchImpl?: FetchLike } = {},
): Promise<TeamsResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const cfg = await resolveConfig(orgId);
  if ("error" in cfg) return { ok: false, error: cfg.error };

  const teamId = message.teamId ?? cfg.defaultTeamId;
  const channelId = message.channelId ?? cfg.defaultChannelId;
  if (!teamId || !channelId) {
    return {
      ok: false,
      error:
        "No Teams channel configured. Set a default Team ID and Channel ID on the Microsoft Teams integration, or pass them explicitly.",
    };
  }

  const tok = await mintToken(cfg, fetchImpl);
  if ("error" in tok) return { ok: false, error: tok.error };

  const url = `${tok.graphBaseUrl}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok.token}`,
        "Content-Type": "application/json",
        "User-Agent": "cosmos-connector",
      },
      body: JSON.stringify({ body: { contentType: "html", content: message.html } }),
    });
  } catch (err) {
    return { ok: false, error: `Teams post failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: { code?: unknown } };
      if (typeof parsed?.error?.code === "string") detail = `: ${parsed.error.code}`;
    } catch {
      /* body not JSON */
    }
    return { ok: false, error: `Teams API error (HTTP ${res.status})${detail}` };
  }
  return { ok: true };
}

/** Verify the org's Teams credential by minting a token (proves the Entra app
 *  creds are valid) — used by the "Test connection" button. Does not post. */
export async function testTeamsConnection(
  orgId: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<TeamsResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const cfg = await resolveConfig(orgId);
  if ("error" in cfg) return { ok: false, error: cfg.error };
  const tok = await mintToken(cfg, fetchImpl);
  if ("error" in tok) return { ok: false, error: tok.error };
  return { ok: true };
}
