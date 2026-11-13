import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, sessionStillValid } from "@/lib/auth/session";
import { trustedClientIp } from "@/lib/auth/client-ip";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { getPresence } from "@/lib/realtime/presence";
import { openStreamGate } from "@/lib/realtime/stream-gate.server";
import { Permission, hasPermission } from "@/lib/rbac/permissions";

// cacheComponents enabled: route segment configs `runtime` and `dynamic`
// are not supported (Node is default, routes are dynamic by default).

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });

  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  // No API key. The stream authenticates once and stays open for hours, so a
  // key's stream would outlive the key's revocation; it also carries the key
  // owner's chat, notifications and presence, which no key scope covers, and
  // the app's own EventSource cannot send a bearer token anyway.
  if (ctx.isApiKey) return new Response("Forbidden", { status: 403 });

  // What this connection may hear, kept current while it stays open (see
  // stream-gate.server.ts): work-item events only for projects whose items
  // the subscriber may read, chat only with CHAT_USE and only from channels
  // they are still in. Each refresh also checks the session the stream opened
  // with against the org's floors, from the address it connected from, so
  // signing out, a revoked session, an idle timeout, a newly required MFA or
  // an allowlist that no longer admits that address ends it. No session
  // cookie: nothing to re-check, so the first refresh closes it and the client
  // reconnects through getAuthContext. The address is the trusted one
  // (`trustedClientIp`: only the header the deployment's edge writes), the
  // same one getAuthContext judged when the stream opened.
  const sessionId = request.cookies.get(SESSION_COOKIE)?.value;
  const clientIp = trustedClientIp(request.headers);
  const gate = await openStreamGate(ctx, {
    stillValid: async () => (sessionId ? sessionStillValid(sessionId, orgId, clientIp) : false),
  });

  // Compute the user's interest set:
  //   - org:{orgId}    — back-compat with publishers that still use the org topic
  //   - user:{userId}  — DMs, mentions, push echoes (post-B5 notifications land here)
  //   - channel:{id}   — for every chat channel the user is a member of, when
  //                      they may use chat at all
  const memberships = hasPermission(ctx.permissions, Permission.CHAT_USE)
    ? await prisma.chatChannelMember.findMany({
        where: { userId: ctx.userId, channel: { orgId, archivedAt: null } },
        select: { channelId: true },
      })
    : [];
  const interest: string[] = [
    topics.org(ctx.orgId),
    topics.user(ctx.userId),
    ...memberships.map((m) => topics.channel(m.channelId)),
  ];

  const encoder = new TextEncoder();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  // Runs once, whether the client went away (cancel) or the server ended it.
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pingInterval) clearInterval(pingInterval);
    if (unsubscribe) unsubscribe();
    const offline = getPresence().disconnect(ctx.userId);
    if (offline === "offline") {
      void getBus().publish(topics.org(ctx.orgId), "chat.presence.changed", {
        userId: ctx.userId,
        status: "offline",
      });
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      // Initial hello with the topic set so the client knows what it's hearing.
      const hello = `event: hello\ndata: ${JSON.stringify({
        orgId: ctx.orgId,
        userId: ctx.userId,
        channels: memberships.map((m) => m.channelId),
        ts: Date.now(),
      })}\n\n`;
      controller.enqueue(encoder.encode(hello));

      // Each event is checked in arrival order: the check may read the
      // database, and a later event must not overtake an earlier one.
      let queue: Promise<void> = Promise.resolve();
      unsubscribe = getBus().subscribe(interest, (event) => {
        queue = queue
          .then(async () => {
            if (!(await gate.admit(event))) {
              if (gate.closed) closeStream();
              return;
            }
            const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          })
          .catch(() => {
            /* ignore — controller may be closed; cancel() will fire */
          });
      });

      // The member was removed, or the session ended, while connected: end the stream.
      function closeStream() {
        stop();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      // Presence: mark online; broadcast the transition to the org so members update.
      const onlineTransition = getPresence().connect(ctx.userId, Date.now());
      if (onlineTransition === "online") {
        void getBus().publish(topics.org(ctx.orgId), "chat.presence.changed", {
          userId: ctx.userId,
          status: "online",
        });
      }

      // Heartbeat every 25 s so intermediate proxies don't close idle connections.
      // The heartbeat also keeps the audience current on a quiet connection.
      pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
          getPresence().heartbeat(ctx.userId, Date.now());
        } catch {
          if (pingInterval) clearInterval(pingInterval);
          return;
        }
        void gate.refreshIfStale().then(
          () => {
            if (gate.closed) closeStream();
          },
          () => {
            /* best-effort: the next event re-checks */
          },
        );
      }, 25_000);
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
