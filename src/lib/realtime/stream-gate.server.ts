import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { visibleChannelWhere } from "@/lib/chat/access";
import { streamDecision, type StreamAudience, type StreamEvent } from "./stream-access";
import { parseTopic } from "./topics";

/**
 * How long a connection's audience is trusted before it is recomputed. A
 * connection lives for hours, and who may read which project changes under it:
 * a project turns on team scoping, someone leaves a team, a role is lowered.
 * Those changes publish nothing the stream could react to, so the bound on
 * hearing a project you have just lost is this interval.
 */
export const AUDIENCE_TTL_MS = 60_000;

/** A burst of events from a brand-new project recomputes once, not per event. */
const UNKNOWN_PROJECT_REFRESH_MS = 5_000;

/** On the member's own topic: their chat channels changed, so recompute before the next channel event. */
const OWN_CHANNEL_CHANGES = new Set(["chat.channel.left", "chat.channel.joined"]);

export interface StreamGate {
  /** Whether to forward this event. Recomputes the audience when it is stale. */
  admit(event: StreamEvent): Promise<boolean>;
  /** Recompute now if the audience is older than AUDIENCE_TTL_MS. */
  refreshIfStale(): Promise<void>;
  /** The member was removed, or the session ended: close the stream. */
  readonly closed: boolean;
  /**
   * The chat channels whose topics the stream should be subscribed to now: the
   * audience's channels, as of the last recompute. The stream re-reads this
   * after each `admit` and `refreshIfStale`, so a channel joined while it is
   * open is heard from then on, and one the member can no longer read is let go.
   */
  readonly channels: ReadonlySet<string>;
}

/**
 * Per-connection access for the org event stream.
 *
 * Built from the AuthContext the request authenticated with, then kept current
 * from the database: every AUDIENCE_TTL_MS, at once when an event says this
 * member's own role or work roles changed or that they joined or left a chat
 * channel, and when an event names a project created after the connection
 * opened. Each recompute also re-reads which chat channels the member may hear
 * (`channels`), which the stream follows. A member removed from the org closes,
 * and so does a connection whose credential `stillValid` no longer accepts (a
 * signed-out, revoked, expired or idle session), checked at each recompute.
 *
 * A refresh keeps the request's key and project ceiling (`isApiKey`, `scopes`,
 * `projectScope`) and takes everything else from the member's stored access,
 * so a refresh can only ever narrow what the original context allowed.
 */
export async function openStreamGate(
  initial: AuthContext,
  opts: {
    now?: () => number;
    /** Re-checks the credential the stream opened with; false closes it. */
    stillValid?: () => Promise<boolean>;
  } = {},
): Promise<StreamGate> {
  const now = opts.now ?? Date.now;
  const stillValid = opts.stillValid ?? (async () => true);
  let ctx = initial;
  let closed = false;
  let audience = await audienceFor(ctx);
  let computedAt = now();
  let lastUnknownRefresh = 0;
  let inflight: Promise<void> | null = null;

  const ownMember = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
    select: { id: true },
  });

  async function recompute(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      const fresh = (await stillValid()) ? await loadMemberAuthContext(initial.orgId, initial.userId) : null;
      if (!fresh) {
        closed = true;
        audience = { readable: new Set(), known: audience.known, chat: false, channels: new Set(), permissions: 0n };
        return;
      }
      ctx = { ...fresh, isApiKey: initial.isApiKey, scopes: initial.scopes, projectScope: initial.projectScope };
      audience = await audienceFor(ctx);
      computedAt = now();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function refreshIfStale(): Promise<void> {
    if (now() - computedAt >= AUDIENCE_TTL_MS) await recompute();
  }

  return {
    get closed() {
      return closed;
    },
    get channels() {
      return audience.channels;
    },
    refreshIfStale,
    async admit(event) {
      if (closed) return false;
      const ownAccessChanged =
        (event.type === "member.updated" && ownMember && memberIdOf(event.data) === ownMember.id) ||
        // Only the member's own user topic reaches this stream.
        (OWN_CHANNEL_CHANGES.has(event.type) && parseTopic(event.topic)?.kind === "user");
      if (ownAccessChanged) {
        await recompute();
      } else {
        await refreshIfStale();
      }
      if (closed) return false;
      let decision = streamDecision(event, audience);
      if (decision === "refresh" && now() - lastUnknownRefresh >= UNKNOWN_PROJECT_REFRESH_MS) {
        lastUnknownRefresh = now();
        await recompute();
        if (closed) return false;
        decision = streamDecision(event, audience);
      }
      return decision === "send";
    },
  };
}

async function audienceFor(ctx: AuthContext): Promise<StreamAudience> {
  const chat = hasPermission(ctx.permissions, Permission.CHAT_USE);
  const [readable, all, channels] = await Promise.all([
    getReadableProjectIds(ctx),
    prisma.project.findMany({ where: { orgId: ctx.orgId }, select: { id: true } }),
    // The channels the stream subscribes to (`channels` above): the member's,
    // less any whose project they can't see (lib/chat/access.ts), as the
    // channel list leaves those out.
    chat
      ? prisma.chatChannelMember.findMany({
          where: { userId: ctx.userId, channel: { orgId: ctx.orgId, archivedAt: null, AND: [await visibleChannelWhere(ctx)] } },
          select: { channelId: true },
        })
      : [],
  ]);
  return {
    readable: new Set(readable),
    known: new Set(all.map((p) => p.id)),
    chat,
    channels: new Set(channels.map((c) => c.channelId)),
    permissions: ctx.permissions,
  };
}

function memberIdOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const id = (data as { memberId?: unknown }).memberId;
  return typeof id === "string" ? id : null;
}
