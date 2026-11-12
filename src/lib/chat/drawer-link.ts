/**
 * Chat opens in the docked drawer, beside whatever page you are on. These are
 * the URL parameters that say so, and the helpers that build and read them.
 *
 *   ?chat=<channelId>               the drawer, on that conversation
 *   ?chat=<channelId>&chatMsg=<id>  …scrolled to that message
 *   ?chat=                          the drawer, on the conversation list
 *   ?chatWith=<userId>[,<userId>…]  a direct message with those people,
 *                                   started (or reopened) on arrival
 *
 * Any page takes them: `ChatLinkMount` (in the org layout) opens the drawer and
 * then removes them from the address bar. A link built on the server
 * (a notification, a "Mentioned in" backlink) has no page to stand on, so it
 * uses the org home; a link built in the browser uses the page it is on.
 *
 * PURE, and imports nothing: the server builds these URLs, the browser reads
 * them, and the proxy's redirect from the old full-page chat uses both.
 */

export const CHAT_PARAM = "chat";
export const CHAT_MESSAGE_PARAM = "chatMsg";
export const CHAT_WITH_PARAM = "chatWith";

const CHAT_PARAMS = [CHAT_PARAM, CHAT_MESSAGE_PARAM, CHAT_WITH_PARAM] as const;

/** A direct message holds at most this many OTHER people (the DM route's cap). */
export const MAX_DM_PEOPLE = 7;

/** Where in chat to land. An empty target is the conversation list. */
export interface ChatDrawerTarget {
  channelId?: string;
  /** A message in `channelId` to bring into view. */
  messageId?: string;
  /** Start, or reopen, a direct message with these people. */
  withUserIds?: string[];
}

/** Removes every chat-drawer parameter from `params`, in place. */
export function deleteChatParams(params: URLSearchParams): void {
  for (const p of CHAT_PARAMS) params.delete(p);
}

/**
 * `base` with the drawer parameters for `target` set, replacing any already
 * there. `base` is a path with an optional query ("/acme/projects?view=list");
 * its hash is dropped, since an old `#msg-…` hash would contradict `chatMsg`.
 */
export function chatDrawerHref(base: string, target: ChatDrawerTarget): string {
  const hashAt = base.indexOf("#");
  const noHash = hashAt === -1 ? base : base.slice(0, hashAt);
  const queryAt = noHash.indexOf("?");
  const path = (queryAt === -1 ? noHash : noHash.slice(0, queryAt)) || "/";
  const params = new URLSearchParams(queryAt === -1 ? "" : noHash.slice(queryAt + 1));
  deleteChatParams(params);
  const people = (target.withUserIds ?? []).filter(Boolean);
  if (people.length > 0) {
    params.set(CHAT_WITH_PARAM, people.join(","));
  } else {
    params.set(CHAT_PARAM, target.channelId ?? "");
    if (target.channelId && target.messageId) params.set(CHAT_MESSAGE_PARAM, target.messageId);
  }
  return `${path}?${params.toString()}`;
}

/** `#msg-<id>`, the anchor the old chat page's links carried, as a message id. */
function messageFromHash(hash: string): string | undefined {
  const m = /^#?msg-(.+)$/.exec(hash);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The target `params` asks for, or null when it asks for no chat at all.
 * `hash` is the address's fragment: an old link redirected here still carries
 * its `#msg-<id>`, and that message is honoured when `chatMsg` is absent.
 */
export function chatDrawerTargetFromParams(
  params: URLSearchParams,
  hash = "",
): ChatDrawerTarget | null {
  const withRaw = params.get(CHAT_WITH_PARAM);
  if (withRaw !== null) {
    const people = [
      ...new Set(
        withRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ].slice(0, MAX_DM_PEOPLE);
    if (people.length > 0) return { withUserIds: people };
  }
  if (!params.has(CHAT_PARAM)) return withRaw !== null ? {} : null;
  const channelId = params.get(CHAT_PARAM)?.trim() || undefined;
  if (!channelId) return {};
  const messageId = params.get(CHAT_MESSAGE_PARAM)?.trim() || messageFromHash(hash);
  return messageId ? { channelId, messageId } : { channelId };
}

/**
 * The old full-page chat's addresses: `/<org>/chat` and `/<org>/chat/<id>`.
 * Null for anything else, including the API (`/api/…`), which is unchanged.
 */
export function legacyChatPath(
  pathname: string,
): { orgSlug: string; channelId?: string } | null {
  const m = /^\/([^/]+)\/chat(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m || m[1] === "api") return null;
  let channelId: string | undefined;
  if (m[2]) {
    try {
      channelId = decodeURIComponent(m[2]);
    } catch {
      return null;
    }
  }
  return channelId ? { orgSlug: m[1], channelId } : { orgSlug: m[1] };
}

/**
 * The chat target a stored link points at, whichever form it is in: the drawer
 * form (`/acme?chat=<id>`) or the old page (`/acme/chat/<id>#msg-<m>`), which
 * notifications sent before the drawer still carry. Null for any other link,
 * and for a link with a scheme, which is someone else's page.
 */
export function chatDrawerTargetFromUrl(url: string | null | undefined): ChatDrawerTarget | null {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(url, "http://cosmos.invalid");
  } catch {
    return null;
  }
  const fromParams = chatDrawerTargetFromParams(u.searchParams, u.hash);
  if (fromParams) return fromParams;
  const legacy = legacyChatPath(u.pathname);
  if (!legacy) return null;
  if (!legacy.channelId) return {};
  const messageId = messageFromHash(u.hash);
  return messageId ? { channelId: legacy.channelId, messageId } : { channelId: legacy.channelId };
}
