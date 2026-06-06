import webpush from "web-push";
import { prisma } from "@/lib/db/client";
import { isInQuietHours } from "./quiet-hours";

let initialized = false;

function initVapid() {
  if (initialized) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) {
    throw new Error("VAPID env vars not configured");
  }
  webpush.setVapidDetails(subject, pub, priv);
  initialized = true;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
}

/**
 * Send a push to all of a user's registered subscriptions. Best-effort: errors
 * are caught per-subscription so one bad endpoint doesn't break the rest.
 * Subscriptions that return 410 Gone are deleted automatically.
 */
export async function pushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  initVapid();

  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    select: { dndEnabled: true, dndStart: true, dndEnd: true, dndTimezone: true },
  });
  if (prefs && isInQuietHours(new Date(), prefs)) {
    // Quiet hours: the Notification row was already written by the caller; we
    // suppress only the push so the bell still catches up when the user returns.
    return { sent: 0, pruned: 0 };
  }

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  let pruned = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
      );
      sent++;
      await prisma.pushSubscription.update({
        where: { id: sub.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (e) {
      const statusCode = (e as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Endpoint gone — clean up
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        pruned++;
      }
      // else: swallow — transient failure
    }
  }

  return { sent, pruned };
}

export function getVapidPublicKey(): string {
  const pub = process.env.VAPID_PUBLIC_KEY;
  if (!pub) throw new Error("VAPID_PUBLIC_KEY not set");
  return pub;
}
