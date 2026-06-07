/**
 * Microsoft 365 (Microsoft Graph) tool executors for the AI assistant — READ-only.
 *
 * Each function:
 * - Reads via `graphFetch(orgId, path, {fetchImpl?})` from
 *   `src/lib/integrations/microsoft-graph.ts`, which resolves the org's SEALED Entra app
 *   credential ({ clientId, clientSecret, tenantId }) + the non-secret `cloud`, performs
 *   the OAuth2 client-credentials token exchange (cloud-correct authority/scope, cached),
 *   and presents the Bearer token to Graph. On a missing/incomplete credential the helper
 *   returns a graceful "not connected" error (mirrors the GitHub/Jira/Slack pattern) so
 *   the model can apologise and continue.
 * - The grant is APP-ONLY, so mailbox/calendar/drive reads target an explicit `userId`.
 * - Returns a SHALLOW shape including content fields (subject/name/etc.) — the egress
 *   chokepoint (src/lib/ai/egress) decides what the MODEL actually sees (gov: structural-
 *   only; subject/body/from/displayName/mail withheld). The executor NEVER returns or logs
 *   the access token or the client secret (graphFetch never surfaces them).
 *
 * The `fetchImpl` is INJECTABLE (threaded into graphFetch) so tests mock BOTH the token
 * endpoint AND Graph without a network.
 */

import { graphFetch, type FetchLike } from "@/lib/integrations/microsoft-graph";

interface M365ToolContext {
  userId: string;
  /** The caller's org — scopes the sealed org credential + the integration config. */
  orgId: string;
  /** Injected fetch for tests; threaded into graphFetch (defaults to global fetch). */
  fetchImpl?: FetchLike;
}

type ToolArgs = Record<string, unknown>;

function clampLimit(raw: unknown): number {
  return Math.min(Math.max(Number(raw ?? 20) || 20, 1), 50);
}

async function safeRun<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

/** Pull the Graph collection array (`value`) off a response, defensively. */
function collection(data: unknown): Record<string, unknown>[] {
  const o = (data ?? {}) as Record<string, unknown>;
  return Array.isArray(o.value) ? (o.value as Record<string, unknown>[]) : [];
}

// ── Tools ──────────────────────────────────────────────────────────────────

export async function m365ListUsers(args: ToolArgs, ctx: M365ToolContext) {
  return safeRun(async () => {
    const limit = clampLimit(args.limit);
    const res = await graphFetch(
      ctx.orgId,
      `/users?$top=${limit}&$select=id,accountEnabled,displayName,mail,userPrincipalName,jobTitle`,
      { fetchImpl: ctx.fetchImpl },
    );
    if (!res.ok) return { error: res.error };

    const users = collection(res.data).map((u) => ({
      id: u.id,
      accountEnabled: u.accountEnabled,
      // Content / PII — included for commercial, WITHHELD for gov by the gate.
      displayName: typeof u.displayName === "string" ? u.displayName : "",
      mail: typeof u.mail === "string" ? u.mail : "",
      userPrincipalName:
        typeof u.userPrincipalName === "string" ? u.userPrincipalName : "",
      jobTitle: typeof u.jobTitle === "string" ? u.jobTitle : "",
    }));
    return { success: true, count: users.length, users };
  });
}

export async function m365ListMessages(args: ToolArgs, ctx: M365ToolContext) {
  return safeRun(async () => {
    const userId = typeof args.userId === "string" ? args.userId.trim() : "";
    if (!userId) return { error: "userId is required (use m365_list_users to find one)" };

    const limit = clampLimit(args.limit);
    const res = await graphFetch(
      ctx.orgId,
      `/users/${encodeURIComponent(userId)}/messages?$top=${limit}&$select=id,receivedDateTime,isRead,hasAttachments,importance,subject,bodyPreview,from,toRecipients,ccRecipients`,
      { fetchImpl: ctx.fetchImpl },
    );
    if (!res.ok) return { error: res.error };

    const messages = collection(res.data).map((m) => {
      const from = (m.from ?? {}) as Record<string, unknown>;
      const fromAddr = (from.emailAddress ?? {}) as Record<string, unknown>;
      return {
        id: m.id,
        receivedDateTime: m.receivedDateTime,
        isRead: m.isRead,
        hasAttachments: m.hasAttachments,
        importance: m.importance,
        // Content / PII — included for commercial, WITHHELD for gov by the gate.
        subject: typeof m.subject === "string" ? m.subject : "",
        bodyPreview: typeof m.bodyPreview === "string" ? m.bodyPreview : "",
        from: typeof fromAddr.address === "string" ? fromAddr.address : "",
      };
    });
    return { success: true, count: messages.length, messages };
  });
}

export async function m365ListEvents(args: ToolArgs, ctx: M365ToolContext) {
  return safeRun(async () => {
    const userId = typeof args.userId === "string" ? args.userId.trim() : "";
    if (!userId) return { error: "userId is required (use m365_list_users to find one)" };

    const limit = clampLimit(args.limit);
    const res = await graphFetch(
      ctx.orgId,
      `/users/${encodeURIComponent(userId)}/calendar/events?$top=${limit}&$select=id,start,end,isAllDay,isCancelled,showAs,subject,location,organizer,attendees`,
      { fetchImpl: ctx.fetchImpl },
    );
    if (!res.ok) return { error: res.error };

    const events = collection(res.data).map((e) => {
      const location = (e.location ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        start: e.start,
        end: e.end,
        isAllDay: e.isAllDay,
        isCancelled: e.isCancelled,
        showAs: e.showAs,
        // Content / PII — included for commercial, WITHHELD for gov by the gate.
        subject: typeof e.subject === "string" ? e.subject : "",
        location:
          typeof location.displayName === "string" ? location.displayName : "",
      };
    });
    return { success: true, count: events.length, events };
  });
}

export async function m365ListDriveItems(args: ToolArgs, ctx: M365ToolContext) {
  return safeRun(async () => {
    const userId = typeof args.userId === "string" ? args.userId.trim() : "";
    if (!userId) return { error: "userId is required (use m365_list_users to find one)" };

    const limit = clampLimit(args.limit);
    const res = await graphFetch(
      ctx.orgId,
      `/users/${encodeURIComponent(userId)}/drive/root/children?$top=${limit}&$select=id,name,size,createdDateTime,lastModifiedDateTime,folder,webUrl`,
      { fetchImpl: ctx.fetchImpl },
    );
    if (!res.ok) return { error: res.error };

    const items = collection(res.data).map((d) => ({
      id: d.id,
      size: d.size,
      createdDateTime: d.createdDateTime,
      lastModifiedDateTime: d.lastModifiedDateTime,
      // `isFolder` derived from the presence of the `folder` facet (a structural bool).
      isFolder: d.folder !== undefined && d.folder !== null,
      // Content / PII — included for commercial, WITHHELD for gov by the gate.
      name: typeof d.name === "string" ? d.name : "",
      webUrl: typeof d.webUrl === "string" ? d.webUrl : "",
    }));
    return { success: true, count: items.length, items };
  });
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/**
 * Map of Microsoft 365 tool name → executor. Returns `null` if the name is not an M365
 * tool, so the parent dispatcher falls through to other tool families.
 */
export async function executeMicrosoft365Tool(
  name: string,
  args: ToolArgs,
  ctx: M365ToolContext,
): Promise<unknown | null> {
  switch (name) {
    case "m365_list_users":
      return m365ListUsers(args, ctx);
    case "m365_list_messages":
      return m365ListMessages(args, ctx);
    case "m365_list_events":
      return m365ListEvents(args, ctx);
    case "m365_list_drive_items":
      return m365ListDriveItems(args, ctx);
    default:
      return null;
  }
}

/** Names of all Microsoft 365 tools — for O(1) membership in the central dispatcher. */
export const M365_TOOL_NAMES: ReadonlySet<string> = new Set([
  "m365_list_users",
  "m365_list_messages",
  "m365_list_events",
  "m365_list_drive_items",
]);
