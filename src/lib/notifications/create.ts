import { prisma } from "@/lib/db/client";
import { getBus } from "@/lib/realtime/bus";
import { topics } from "@/lib/realtime/topics";
import { pushToUser } from "@/lib/notifications/push";
import { queueTeamsNotification } from "@/lib/integrations/microsoft/teams-app/outbox.server";
import { queueSlackNotification } from "@/lib/integrations/slack/outbox.server";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { canReadInProject } from "@/lib/rbac/require-project-read";
import type { PermissionKey } from "@/lib/rbac/permissions";
import { isPmSubjectType, PM_SUBJECT_READ, resolvePmSubject } from "@/lib/pm/subjects";

export interface CreateNotificationInput {
  orgId: string;
  userId: string;
  type: string;          // e.g. "work_item.assigned", "comment.mentioned"
  title: string;
  message?: string;
  relatedId?: string | null;
  relatedType?: string | null;
  url?: string | null;   // deep link for click-through
  /**
   * The project the notification is about. Required for a PM register item
   * (relatedType "pm_<kind>"), which must be in it, or nothing is sent. A work
   * item's project is always looked up from relatedId; this is ignored for it.
   */
  projectId?: string | null;
}

const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * What a notification is about, and the check reading that takes:
 *   - a work item: ITEM_READ in the item's OWN project, looked up here, never
 *     taken from the caller;
 *   - a PM register item ("pm_<kind>"): that register's read permission
 *     (PM_SUBJECT_READ), in the project the caller names, which the item must
 *     belong to;
 *   - anything else that names a project: that project's visibility;
 *   - anything else: nothing to check here ("open").
 * "unknown" is something that should name an item but whose item can't be
 * told; it is never sent, since a missing answer must not read as "allowed".
 */
type Subject =
  | { kind: "open" }
  | { kind: "unknown"; why: string }
  | { kind: "read"; projectId: string; action: PermissionKey }
  | { kind: "visible"; projectId: string };

async function subjectOf(input: CreateNotificationInput): Promise<Subject> {
  const t = input.relatedType ?? null;
  if (t === "work_item") {
    if (!isUuid(input.relatedId)) return { kind: "unknown", why: "no work item id" };
    const item = await prisma.workItem.findFirst({ where: { id: input.relatedId, orgId: input.orgId }, select: { projectId: true } });
    if (!item) return { kind: "unknown", why: "no such work item in this org" };
    return { kind: "read", projectId: item.projectId, action: "ITEM_READ" };
  }
  if (t?.startsWith("pm_")) {
    const kind = t.slice(3);
    if (!isPmSubjectType(kind)) return { kind: "unknown", why: "not a register Cosmos knows" };
    if (!isUuid(input.projectId)) return { kind: "unknown", why: "no project named" };
    if (!isUuid(input.relatedId)) return { kind: "unknown", why: "no item id" };
    // Also rules out a project that doesn't exist, or is another org's.
    if (!(await resolvePmSubject(kind, input.relatedId, input.orgId, input.projectId))) {
      return { kind: "unknown", why: "no such item in the project named" };
    }
    return { kind: "read", projectId: input.projectId, action: PM_SUBJECT_READ[kind] };
  }
  if (input.projectId != null) {
    return isUuid(input.projectId) ? { kind: "visible", projectId: input.projectId } : { kind: "unknown", why: "a malformed project id" };
  }
  return { kind: "open" };
}

/**
 * Whether the recipient may read what the notification is about, judged as
 * the RECIPIENT (never as whoever caused it), with the check that thing's own
 * page makes: its read permission, any policy denying it, and the project's
 * team scoping (requireProjectRead). Every channel (the bell, live updates,
 * web push, Teams, Slack) goes out from createNotification, so this one check
 * covers them all. Notifications about other things (feedback, meetings,
 * chat, time) are not judged here.
 */
export async function recipientCanSeeNotification(input: CreateNotificationInput): Promise<boolean> {
  const about = await subjectOf(input);
  if (about.kind === "open") return true;
  if (about.kind === "unknown") {
    // Not sent. Most often a caller that left something out: say so.
    console.warn(`[notifications] ${input.type} about ${input.relatedType ?? "nothing"} not sent in org ${input.orgId}: ${about.why}`);
    return false;
  }
  const ctx = await loadMemberAuthContext(input.orgId, input.userId);
  if (!ctx) return false;
  return about.kind === "read" ? canReadInProject(ctx, about.projectId, about.action) : isProjectVisible(ctx, about.projectId);
}

/**
 * Create a notification row, publish via SSE broker, and best-effort dispatch
 * a web push. Per-channel failures don't abort the others — the DB row
 * is the canonical record; SSE + push are convenience.
 *
 * Nothing at all (null) when the recipient can't read what it's about, or
 * when that can't be checked. A check that fails is logged here: most callers
 * treat notifying as best effort and discard errors, so it can't be left to them.
 *
 * The Notification model fields (see prisma/schema.prisma):
 *   id, orgId, userId, type, title, body, refType, refId, read, createdAt
 */
export async function createNotification(input: CreateNotificationInput) {
  let allowed: boolean;
  try {
    allowed = await recipientCanSeeNotification(input);
  } catch (e) {
    console.error(
      `[notifications] couldn't check who may read a ${input.type} in org ${input.orgId}, so it wasn't sent:`,
      e instanceof Error ? e.message : "unknown error",
    );
    return null;
  }
  if (!allowed) return null;
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

  // Teams (COSMOS-202 T2): queued for the bot when the person chose this type there
  try {
    await queueTeamsNotification(input);
  } catch {
    /* convenience, like push */
  }

  // Slack: queued only (a job sends it), so Slack being down never fails the
  // change behind this notification. A failure to queue is logged, not hidden.
  try {
    await queueSlackNotification(input);
  } catch (e) {
    console.warn(`[slack] couldn't queue a notification for org ${input.orgId}:`, e instanceof Error ? e.message : "unknown error");
  }

  return notification;
}
