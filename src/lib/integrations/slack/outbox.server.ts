import { prisma } from "@/lib/db/client";
import { SLACK_RECHECK_MS, SLACK_TYPE_OF_NOTIFICATION } from "./config";

/**
 * Putting a Cosmos notification in the Slack outbox. Kept apart from the
 * sender (notify.server.ts) so createNotification can call it cheaply: two
 * indexed reads and an insert, never a call to Slack. A row holds ids and the
 * notification's own link; the message is built, as its reader, when it's sent.
 */

const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Called for every Cosmos notification. Queues it when it's an assignment or
 * an @mention on a work item, the org has Slack connected, and the person
 * hasn't opted out, unlinked, or been found to have no Slack account lately.
 * Someone never matched is queued too: the sender matches them first.
 */
export async function queueSlackNotification(n: {
  orgId: string;
  userId: string;
  type: string;
  relatedType?: string | null;
  relatedId?: string | null;
  url?: string | null;
}): Promise<boolean> {
  const type = SLACK_TYPE_OF_NOTIFICATION[n.type];
  if (!type || n.relatedType !== "work_item" || !isUuid(n.relatedId)) return false;
  const install = await prisma.slackInstallation.findUnique({ where: { orgId: n.orgId }, select: { status: true } });
  if (install?.status !== "ACTIVE") return false;
  const link = await prisma.slackUserLink.findUnique({
    where: { orgId_userId: { orgId: n.orgId, userId: n.userId } },
    select: { status: true, notifyTypes: true, checkedAt: true },
  });
  if (link) {
    if (!link.notifyTypes.includes(type)) return false;
    if (link.status === "UNLINKED" || link.status === "NEEDS_REVIEW") return false;
    if (link.status === "NO_MATCH" && link.checkedAt && Date.now() - link.checkedAt.getTime() < SLACK_RECHECK_MS) return false;
  }
  await prisma.slackOutbox.create({
    data: { orgId: n.orgId, userId: n.userId, kind: "notification", payload: { type, workItemId: n.relatedId, url: n.url ?? null } },
  });
  return true;
}
