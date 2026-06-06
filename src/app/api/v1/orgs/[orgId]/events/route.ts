import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { getPresence } from "@/lib/realtime/presence";

// cacheComponents enabled: route segment configs `runtime` and `dynamic`
// are not supported (Node is default, routes are dynamic by default).

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });

  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });

  // Compute the user's interest set:
  //   - org:{orgId}    — back-compat with publishers that still use the org topic
  //   - user:{userId}  — DMs, mentions, push echoes (post-B5 notifications land here)
  //   - channel:{id}   — for every chat channel the user is a member of
  const memberships = await prisma.chatChannelMember.findMany({
    where: { userId: ctx.userId, channel: { orgId, archivedAt: null } },
    select: { channelId: true },
  });
  const interest: string[] = [
    topics.org(ctx.orgId),
    topics.user(ctx.userId),
    ...memberships.map((m) => topics.channel(m.channelId)),
  ];

  const encoder = new TextEncoder();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

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

      unsubscribe = getBus().subscribe(interest, (event) => {
        const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          /* ignore — controller may be closed; cancel() will fire */
        }
      });

      // Presence: mark online; broadcast the transition to the org so members update.
      const onlineTransition = getPresence().connect(ctx.userId, Date.now());
      if (onlineTransition === "online") {
        void getBus().publish(topics.org(ctx.orgId), "chat.presence.changed", {
          userId: ctx.userId,
          status: "online",
        });
      }

      // Heartbeat every 25 s so intermediate proxies don't close idle connections.
      pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
          getPresence().heartbeat(ctx.userId, Date.now());
        } catch {
          if (pingInterval) clearInterval(pingInterval);
        }
      }, 25_000);
    },
    cancel() {
      if (pingInterval) clearInterval(pingInterval);
      if (unsubscribe) unsubscribe();
      const offline = getPresence().disconnect(ctx.userId);
      if (offline === "offline") {
        void getBus().publish(topics.org(ctx.orgId), "chat.presence.changed", {
          userId: ctx.userId,
          status: "offline",
        });
      }
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
