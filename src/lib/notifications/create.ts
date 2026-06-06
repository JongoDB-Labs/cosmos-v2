import { prisma } from "@/lib/db/client";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { pushToUser } from "@/lib/notifications/push";

export interface CreateNotificationInput {
  orgId: string;
  userId: string;
  type: string;          // e.g. "work_item.assigned", "comment.mentioned"
  title: string;
  message?: string;
  relatedId?: string | null;
  relatedType?: string | null;
  url?: string | null;   // deep link for click-through
}

/**
 * Create a notification row, publish via SSE broker, and best-effort dispatch
 * a web push. Per-channel failures don't abort the others — the DB row
 * is the canonical record; SSE + push are convenience.
 *
 * The Notification model fields (see prisma/schema.prisma):
 *   id, orgId, userId, type, title, body, refType, refId, read, createdAt
 */
export async function createNotification(input: CreateNotificationInput) {
  const notification = await prisma.notification.create({
    data: {
      orgId: input.orgId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.message ?? "",
      refType: input.relatedType ?? null,
      refId: input.relatedId ?? null,
      url: input.url ?? null,
    },
  });

  // SSE — publish directly to the recipient's user topic (no org fan-out)
  try {
    await getBus().publish(topics.user(input.userId), "notification.created", {
      id: notification.id,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.message ?? "",
      refType: input.relatedType ?? null,
      refId: input.relatedId ?? null,
      url: input.url ?? null,
      createdAt: notification.createdAt,
    });
  } catch {
    /* swallow */
  }

  // Web push — only for the target user
  try {
    await pushToUser(input.userId, {
      title: input.title,
      body: input.message ?? "",
      url: input.url ?? "/",
      tag: input.type,
    });
  } catch {
    // VAPID not configured, no subscriptions, etc. — silent
  }

  return notification;
}
