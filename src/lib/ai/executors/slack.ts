/**
 * Slack tool executors for the AI assistant — READ-focused + one safe write.
 *
 * Each function:
 * - Resolves the org's sealed Slack bot token via getOrgCredential(orgId, 'slack')
 *   (org-SHARED, not per-user). The sealed bundle is `{ botToken }`. On a missing
 *   credential, returns a graceful `{ error }` (mirrors the GitHub "not connected"
 *   pattern) so the model can apologise and continue.
 * - Resolves the optional `defaultChannel` (an id) from the integration's non-secret
 *   config (Integration.config, plaintext).
 * - Calls the Slack Web API (`https://slack.com/api/<method>`) via `fetch` with
 *   `Authorization: Bearer <botToken>`. Slack returns HTTP 200 with `{ok:false,error}`
 *   on a logical failure (bad token, missing scope, channel not found, …) — we map
 *   that to a graceful, TOKEN-FREE tool error. The fetch is INJECTABLE via the
 *   optional ctx.fetchImpl so tests mock it without a network.
 * - Returns a SHALLOW shape including the message text — the egress chokepoint
 *   (src/lib/ai/egress) decides what the MODEL actually sees (gov: structural-only,
 *   ts/channel/user/type; text/blocks/name withheld). The executor NEVER returns the
 *   token, and we never log it.
 */

import { prisma } from "@/lib/db/client";
import { getOrgCredential } from "@/lib/integrations/credentials";

/** Minimal fetch signature we depend on — lets tests inject a mock. */
type FetchLike = (
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

interface SlackToolContext {
  userId: string;
  /** The caller's org — scopes the sealed org credential + the integration config. */
  orgId: string;
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

type ToolArgs = Record<string, unknown>;

const API_BASE = "https://slack.com/api";
const NOT_CONNECTED =
  "Slack is not connected for this organization. Ask an admin to install the Slack integration (paste the Bot User OAuth Token, xoxb-…) on the Integrations page.";

interface SlackAccess {
  botToken: string;
  defaultChannel?: string;
}

/** Resolve the org's sealed Slack bot token + non-secret config, or a graceful error. */
async function resolveSlackAccess(
  ctx: SlackToolContext,
): Promise<{ error: string } | SlackAccess> {
  const bundle = await getOrgCredential(ctx.orgId, "slack");
  if (!bundle || !bundle.botToken) {
    return { error: NOT_CONNECTED };
  }
  const integration = await prisma.integration.findFirst({
    where: { orgId: ctx.orgId, provider: "slack" },
    select: { config: true },
  });
  const config = (integration?.config ?? {}) as Record<string, unknown>;
  const defaultChannel =
    typeof config.defaultChannel === "string" ? config.defaultChannel : undefined;
  return { botToken: bundle.botToken, defaultChannel };
}

/**
 * Call a Slack Web API method with the sealed bot token. Slack returns HTTP 200 even
 * on logical failure, signalling success via the body `ok` flag — so we surface a
 * clean, token-free error from `error` when `ok` is false (or on a transport error).
 */
async function slackCall(
  ctx: SlackToolContext,
  token: string,
  method: string,
  opts: { query?: string; body?: Record<string, unknown> },
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const doFetch = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const isPost = opts.body !== undefined;
  const url = `${API_BASE}/${method}${opts.query ? `?${opts.query}` : ""}`;
  const res = await doFetch(url, {
    method: isPost ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(isPost ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      "User-Agent": "cosmos-connector",
    },
    ...(isPost ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) {
    return { ok: false, error: `Slack API error (HTTP ${res.status})` };
  }
  const data = ((await res.json()) ?? {}) as Record<string, unknown>;
  if (data.ok !== true) {
    const err = typeof data.error === "string" ? data.error : "unknown_error";
    return { ok: false, error: `Slack API error: ${err}` };
  }
  return { ok: true, data };
}

function clampLimit(raw: unknown, def: number, max: number): number {
  return Math.min(Math.max(Number(raw ?? def) || def, 1), max);
}

async function safeRun<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

export async function slackListChannels(args: ToolArgs, ctx: SlackToolContext) {
  return safeRun(async () => {
    const access = await resolveSlackAccess(ctx);
    if ("error" in access) return access;

    const limit = clampLimit(args.limit, 50, 200);
    const res = await slackCall(ctx, access.botToken, "conversations.list", {
      query: `limit=${limit}&types=public_channel,private_channel&exclude_archived=false`,
    });
    if (!res.ok) return { error: res.error };

    const raw = Array.isArray(res.data.channels) ? res.data.channels : [];
    const channels = raw.map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        id: o.id,
        // Content (name/topic/purpose) — included for commercial, WITHHELD for gov.
        name: typeof o.name === "string" ? o.name : "",
        is_private: o.is_private,
        is_archived: o.is_archived,
        created: o.created,
      };
    });
    return { success: true, count: channels.length, channels };
  });
}

export async function slackSearchMessages(args: ToolArgs, ctx: SlackToolContext) {
  return safeRun(async () => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { error: "query is required" };

    const access = await resolveSlackAccess(ctx);
    if ("error" in access) return access;

    const limit = clampLimit(args.limit, 20, 50);
    const res = await slackCall(ctx, access.botToken, "search.messages", {
      query: `query=${encodeURIComponent(query)}&count=${limit}`,
    });
    if (!res.ok) return { error: res.error };

    const messagesWrap = (res.data.messages ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(messagesWrap.matches) ? messagesWrap.matches : [];
    const messages = raw.map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      // `channel` may be an object {id,name} or a bare id string — normalize to id.
      let channelId: unknown = o.channel;
      if (channelId && typeof channelId === "object") {
        channelId = (channelId as Record<string, unknown>).id;
      }
      return {
        ts: o.ts,
        channel: channelId,
        user: o.user,
        type: typeof o.type === "string" ? o.type : "message",
        // Content (text) — included for commercial, WITHHELD for gov by the gate.
        text: typeof o.text === "string" ? o.text : "",
      };
    });
    return { success: true, count: messages.length, messages };
  });
}

export async function slackPostMessage(args: ToolArgs, ctx: SlackToolContext) {
  return safeRun(async () => {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) return { error: "text is required" };

    const access = await resolveSlackAccess(ctx);
    if ("error" in access) return access;

    const channel =
      (typeof args.channel === "string" && args.channel) ||
      access.defaultChannel;
    if (!channel) {
      return {
        error:
          "channel is required (none provided and the Slack integration has no defaultChannel configured).",
      };
    }

    const res = await slackCall(ctx, access.botToken, "chat.postMessage", {
      body: { channel, text },
    });
    if (!res.ok) return { error: res.error };

    // The created entity → re-gated structurally for gov (ts/channel only).
    return {
      success: true,
      message: { ts: res.data.ts, channel: res.data.channel },
    };
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/**
 * Map of Slack tool name → executor. Returns `null` if the name is not a Slack tool,
 * so the parent dispatcher falls through to other tool families.
 */
export async function executeSlackTool(
  name: string,
  args: ToolArgs,
  ctx: SlackToolContext,
): Promise<unknown | null> {
  switch (name) {
    case "slack_list_channels":
      return slackListChannels(args, ctx);
    case "slack_search_messages":
      return slackSearchMessages(args, ctx);
    case "slack_post_message":
      return slackPostMessage(args, ctx);
    default:
      return null;
  }
}

/** Names of all Slack tools — for O(1) membership in the central dispatcher. */
export const SLACK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "slack_list_channels",
  "slack_search_messages",
  "slack_post_message",
]);
