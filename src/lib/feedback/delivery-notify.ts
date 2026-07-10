// Owner notifications for autonomous-delivery outcomes. The daemon resolves
// tickets silently — a park (action needed) or a ship (heads-up) should reach a
// human without them polling the board. Rides the existing notification pipeline
// (`createNotification` = bell + SSE + web push with quiet-hours), gated by the
// org's `autonomousDelivery.notify` toggles (Settings → Feedback automation).
// Best-effort by contract: a notify hiccup must never fail the delivery step
// it rides on.
import { prisma } from "@/lib/db/client";
import { createNotification } from "@/lib/notifications/create";
import { readAutomationConfig } from "@/lib/feedback/automation-config";

export type DeliveryEvent = "parked" | "shipped";

export interface DeliveryEventInfo {
  /** Ticket ref, e.g. "COSMOS-19". */
  key: string;
  title: string;
  /** Why it parked (gate reason / reviewer verdict / error) — parked only. */
  reason?: string;
  /** Version shipped or proposed. */
  version?: string;
  prUrl?: string;
  /** Work item id — used for the deep link. */
  workItemId: string;
}

/** Notify the org's OWNERs of a delivery outcome, honoring the per-event
 *  toggles. Recipients are owners because autonomous delivery is an owner-level
 *  capability — the people who can approve a parked draft PR. Never throws. */
export async function notifyDeliveryEvent(
  orgId: string,
  event: DeliveryEvent,
  info: DeliveryEventInfo,
): Promise<void> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, settings: true },
    });
    if (!org) return;
    const cfg = readAutomationConfig(org.settings);
    if (!cfg.autonomousDelivery.notify[event]) return;

    const owners = await prisma.orgMember.findMany({
      where: { orgId, role: "OWNER" },
      select: { userId: true },
    });
    if (owners.length === 0) return;

    const title =
      event === "parked"
        ? `${info.key} needs review${info.version ? ` (v${info.version})` : ""}`
        : `${info.key} shipped${info.version ? ` in v${info.version}` : ""}`;
    const message =
      event === "parked"
        ? `${info.title} — ${info.reason ?? "parked for review"}${info.prUrl ? `. Draft PR: ${info.prUrl}` : ""}`
        : `${info.title}${info.prUrl ? ` — ${info.prUrl}` : ""}`;
    const url = `/${org.slug}/issues?item=${info.workItemId}`;

    for (const o of owners) {
      await createNotification({
        orgId,
        userId: o.userId,
        type: event === "parked" ? "delivery.parked" : "delivery.shipped",
        title,
        message,
        relatedId: info.workItemId,
        relatedType: "work_item",
        url,
      }).catch(() => undefined);
    }
  } catch {
    /* best-effort by contract */
  }
}
