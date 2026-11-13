/**
 * Whose access a webhook carries, and who may read what it sent.
 *
 * A webhook has no project filter of its own: it is subscribed to event names,
 * and events come from every project in the org. So it acts for the person who
 * created it. An event is sent only if that person can read its project when it
 * is sent (deliver.server.ts), and once they are no longer a member it sends
 * nothing at all. Its delivery log holds those events' payloads, so reading it
 * needs ITEM_READ as well as WEBHOOK_MANAGE, and shows only deliveries from
 * projects the reader can read.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { requireAccess } from "@/lib/abac/require-access";
import { ForbiddenError, type AuthContext } from "@/lib/rbac/check";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { WEBHOOK_PUBLIC_SELECT } from "./dto";

/** Why a webhook sends nothing, as the settings page says it. */
export const PAUSED = {
  noCreator: "It has no recorded creator. Create it again to resume.",
  creatorLeft: "The person who created it is no longer a member of this organization. Create it again to resume.",
} as const;

/** Recorded on a delivery that was not sent because of whose webhook it is. */
export const NOT_SENT_CANT_READ = "Not sent: the person who created this webhook can't read this project.";

export type CreatorReach = { paused: string } | { readable: Set<string> };

async function canReadItems(ctx: AuthContext): Promise<boolean> {
  try {
    await requireAccess(ctx, "ITEM_READ");
    return true;
  } catch (e) {
    if (e instanceof ForbiddenError) return false;
    throw e;
  }
}

/** What a webhook created by `createdById` may send now: nothing (and why), or events from these projects. */
export async function creatorReach(orgId: string, createdById: string | null): Promise<CreatorReach> {
  if (!createdById) return { paused: PAUSED.noCreator };
  const ctx = await loadMemberAuthContext(orgId, createdById);
  if (!ctx) return { paused: PAUSED.creatorLeft };
  if (!(await canReadItems(ctx))) return { readable: new Set() };
  return { readable: new Set(await getReadableProjectIds(ctx)) };
}

/** For each webhook, why it is paused, or null. One query for the lot. */
export async function pausedReasons(
  orgId: string,
  hooks: { id: string; createdById: string | null }[],
): Promise<Map<string, string | null>> {
  const creators = [...new Set(hooks.map((w) => w.createdById).filter((id): id is string => !!id))];
  // A removed member doesn't come back from this read (src/lib/db/client.ts).
  const current = new Set(
    creators.length
      ? (await prisma.orgMember.findMany({ where: { orgId, userId: { in: creators } }, select: { userId: true } })).map((m) => m.userId)
      : [],
  );
  return new Map(
    hooks.map((w) => [w.id, !w.createdById ? PAUSED.noCreator : current.has(w.createdById) ? null : PAUSED.creatorLeft]),
  );
}

/**
 * The settings list: every webhook in the org, without its secret, each with
 * why it is paused. The GET route and the settings page's first paint both
 * send this, so the two can't disagree.
 */
export async function listWebhooks(orgId: string) {
  const hooks = await prisma.webhook.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    select: WEBHOOK_PUBLIC_SELECT,
  });
  const paused = await pausedReasons(orgId, hooks);
  return hooks.map((w) => ({ ...w, pausedReason: paused.get(w.id) ?? null }));
}

/**
 * The deliveries `ctx` may read: needs ITEM_READ, then only deliveries about a
 * project it can read, or about no project (a test). Null: none at all.
 */
export async function readableDeliveriesWhere(ctx: AuthContext): Promise<Prisma.WebhookDeliveryWhereInput | null> {
  if (!(await canReadItems(ctx))) return null;
  const readable = await getReadableProjectIds(ctx);
  return { OR: [{ projectId: null }, { projectId: { in: readable } }] };
}
