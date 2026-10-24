import { prisma } from "@/lib/db/client";

/**
 * COSMOS-202 T2: putting a Cosmos notification in the Teams outbox. Kept apart
 * from the sender (notify.server.ts) so createNotification can call it without
 * importing the Teams app. A row holds ids only; the card is read at send time.
 */

export const NOTIFY_TYPES = ["assigned", "mentioned", "due_tomorrow"] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

/** Cosmos notification type -> the Teams choice that covers it. */
const FROM_NOTIFICATION: Record<string, NotifyType> = {
  "work_item.assigned": "assigned",
  "comment.mentioned": "mentioned",
};

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Called for every Cosmos notification: queue it for Teams when it's one the
 * person chose and they have a chat with the bot. Ids only; cheap otherwise.
 */
export async function queueTeamsNotification(n: { orgId: string; userId: string; type: string; relatedType?: string | null; relatedId?: string | null }) {
  const type = FROM_NOTIFICATION[n.type];
  if (!type || n.relatedType !== "work_item" || !isUuid(n.relatedId)) return false;
  const conv = await prisma.teamsConversation.findUnique({
    where: { orgId_userId: { orgId: n.orgId, userId: n.userId } },
    select: { id: true, notifyTypes: true },
  });
  if (!conv?.notifyTypes.includes(type)) return false;
  await prisma.teamsOutbox.create({
    data: { orgId: n.orgId, teamsConversationId: conv.id, kind: "notification", payload: { type, workItemId: n.relatedId } },
  });
  return true;
}

