import { prisma } from "@/lib/db/client";
import { createClassificationResolver, type ClassificationResolver } from "@/lib/classification/resolver";
import { entityUrl } from "@/lib/mentions/urls";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { configuredPublicOrigin } from "@/lib/integrations/microsoft/hosts";
import { cqlEmailTitles } from "@/lib/query/flag";
import { tooLateToSend } from "@/lib/jobs/side-effect-window";
import { findReadableWorkItem } from "@/lib/work-items/query/readable-item.server";
import { SLACK_RECHECK_MS, isSlackNotifyType, type SlackNotifyType } from "./config";
import { recordSlackDelivery, recordSlackFailure, slackBotToken } from "./install.server";
import { matchMember } from "./links.server";
import { buildSlackMessage } from "./message";
import { openDirectMessage, postMessage, SlackApiError, type SlackDeps } from "./web-api.server";

/**
 * Sending the Slack outbox, from a job, so Slack being slow or down never
 * holds up (or fails) the Cosmos change that caused a notification.
 *
 * Everything a message says is decided at SEND time, as its recipient: still
 * an active member, still linked, still wanting this kind of message, and
 * still able to open the item. Any "no" and nothing is sent. The message is
 * the item's key, a link, and its title only where the org lets titles leave
 * Cosmos by email (the filter-email rule, cqlEmailTitles) and the item isn't
 * restricted by classification or marked.
 *
 * Failures are never swallowed: each is counted in the job's result (the
 * admin's jobs readout), logged by code, and kept on the org's install for its
 * admin. Transient ones (rate limits, Slack errors, timeouts) back off and
 * retry; a dead token stops the org's sends until an admin reconnects.
 *
 * One org's trouble never holds up another's: an org whose stored token can't
 * be read, or that Slack rate-limited, is left alone for the rest of the run,
 * its messages still waiting, and every other org's go out.
 *
 * Delivery is at least once: a message whose send timed out after Slack took
 * it is sent again on the retry.
 */

const MAX_ATTEMPTS = 6;
const BATCH = 50;

export interface DrainResult {
  sent: number;
  /** Not sent, by design: opted out, unlinked, can't see the item, too late. */
  skipped: number;
  retried: number;
  /** Not sent because Slack (or Cosmos) failed, for good. */
  failed: number;
}

interface OrgContext {
  token: { token: string; teamId: string } | null;
  slug: string;
  titlesAllowed: boolean;
  resolver: ClassificationResolver;
  origin: string | null;
}

type Plan = { skip: string } | { send: { slackUserId: string; text: string; blocks: unknown[] } };

/** A path the notification carried, if it is one: same-origin, absolute path, nothing odd. */
const safePath = (u: unknown): string | null =>
  typeof u === "string" && /^\/(?!\/)[^\s\\]*$/.test(u) && u.length <= 2000 ? u : null;

const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

async function loadOrg(orgId: string): Promise<OrgContext | null> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true, settings: true, tenantClass: true } });
  if (!org) return null;
  const install = await prisma.slackInstallation.findUnique({ where: { orgId }, select: { publicOrigin: true } });
  return {
    token: await slackBotToken(orgId),
    slug: org.slug,
    titlesAllowed: cqlEmailTitles(org.settings, org.tenantClass),
    resolver: await createClassificationResolver(orgId),
    // Links go to the configured public URL, else where the admin installed from.
    origin: configuredPublicOrigin() ?? install?.publicOrigin ?? null,
  };
}

async function plan(
  row: { orgId: string; userId: string; payload: unknown },
  org: OrgContext,
  now: Date,
  deps?: SlackDeps,
): Promise<Plan> {
  const p = (row.payload ?? {}) as { type?: unknown; workItemId?: unknown; url?: unknown };
  if (!isSlackNotifyType(p.type) || !isUuid(p.workItemId)) return { skip: "bad_row" };
  const type: SlackNotifyType = p.type;
  if (!org.token || !org.origin) return { skip: "not_connected" };

  // Still here, and still active?
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { deactivatedAt: true } });
  if (!user || user.deactivatedAt) return { skip: "not_member" };
  const auth = await loadMemberAuthContext(row.orgId, row.userId);
  if (!auth) return { skip: "not_member" };
  // Someone whose role doesn't read notifications (no bell, no Teams, and no
  // say over their Slack choices) gets none in Slack either.
  if (!hasPermission(auth.permissions, Permission.NOTIFICATION_READ)) return { skip: "no_notifications" };

  // Linked? Someone never matched (or not for a day) is looked up now.
  let link = await prisma.slackUserLink.findUnique({ where: { orgId_userId: { orgId: row.orgId, userId: row.userId } } });
  if (!link || (link.status === "NO_MATCH" && (!link.checkedAt || now.getTime() - link.checkedAt.getTime() >= SLACK_RECHECK_MS))) {
    await matchMember({ orgId: row.orgId, userId: row.userId, token: org.token.token, teamId: org.token.teamId, now }, deps);
    link = await prisma.slackUserLink.findUnique({ where: { orgId_userId: { orgId: row.orgId, userId: row.userId } } });
  }
  if (!link || link.status !== "LINKED" || !link.slackUserId) return { skip: "not_linked" };
  if (!link.notifyTypes.includes(type)) return { skip: "opted_out" };

  // Can they open it, now?
  const item = await findReadableWorkItem({ ...auth, isApiKey: false }, row.orgId, p.workItemId);
  if (!item) return { skip: "not_visible" };
  const showTitle = org.titlesAllowed && !org.resolver.restricted(item.project.id, item.title);
  const path = safePath(p.url) ?? entityUrl("workItem", { orgSlug: org.slug, id: item.ticketKey }) ?? `/${org.slug}/work-items?item=${item.id}`;
  const msg = buildSlackMessage({ type, key: item.ticketKey, title: showTitle ? item.title : null, url: `${org.origin}${path}` });
  return { send: { slackUserId: link.slackUserId, ...msg } };
}

/**
 * Send what's due. Idempotent per row: a row is deleted once sent or settled.
 * `orgId` drains only those orgs (tests share a database, so each drains its own).
 */
export async function drainSlackOutbox(
  opts: { signal?: AbortSignal; deps?: SlackDeps; now?: () => Date; orgId?: string | string[] } = {},
): Promise<DrainResult> {
  const now = opts.now ?? (() => new Date());
  const out: DrainResult = { sent: 0, skipped: 0, retried: 0, failed: 0 };
  const rows = await prisma.slackOutbox.findMany({
    where: { nextAttemptAt: { lte: now() }, ...(opts.orgId ? { orgId: Array.isArray(opts.orgId) ? { in: opts.orgId } : opts.orgId } : {}) },
    orderBy: { nextAttemptAt: "asc" },
    take: BATCH,
  });
  const orgs = new Map<string, OrgContext | null>();
  const delivered = new Set<string>();
  /** Orgs whose token died in this run: their rows are already dropped and counted. */
  const dead = new Set<string>();
  /** Orgs left alone for the rest of this run (token unreadable, or rate-limited): their rows wait. */
  const held = new Set<string>();
  const done = (id: string) => prisma.slackOutbox.deleteMany({ where: { id } });

  for (const row of rows) {
    if (opts.signal?.aborted) break;
    if (dead.has(row.orgId) || held.has(row.orgId)) continue;
    // After an outage, a message about something long past is noise: skip it.
    if (tooLateToSend(row.createdAt, now())) {
      await done(row.id);
      out.skipped++;
      continue;
    }
    if (!orgs.has(row.orgId)) {
      try {
        orgs.set(row.orgId, await loadOrg(row.orgId));
      } catch (e) {
        // Typically a token sealed under a vault key since retired from the
        // keyring. Only this org waits; the error says why (never the token).
        held.add(row.orgId);
        console.error(
          `[slack] org ${row.orgId}: credential_unreadable; its messages wait until an admin reconnects Slack.`,
          e instanceof Error ? e.message.slice(0, 200) : "unknown error",
        );
        await recordSlackFailure(row.orgId, new SlackApiError("credential_unreadable", 0), now()).catch((err: unknown) =>
          console.error(`[slack] org ${row.orgId}: couldn't record the failure:`, err instanceof Error ? err.message : "unknown error"),
        );
        continue;
      }
    }
    const org = orgs.get(row.orgId);
    try {
      const p = org ? await plan(row, org, now(), opts.deps) : ({ skip: "no_org" } as const);
      if ("skip" in p) {
        await done(row.id);
        out.skipped++;
        continue;
      }
      const channel = await openDirectMessage(org!.token!.token, p.send.slackUserId, opts.deps);
      await postMessage(org!.token!.token, { channel, text: p.send.text, blocks: p.send.blocks }, opts.deps);
      await done(row.id);
      delivered.add(row.orgId);
      out.sent++;
    } catch (e) {
      const err = e instanceof SlackApiError ? e : null;
      if (err) await recordSlackFailure(row.orgId, err, now());
      else console.error(`[slack] sending a notification failed for org ${row.orgId}:`, e instanceof Error ? e.message : "unknown error");
      if (err?.tokenDead) {
        // Nothing for this org can go until an admin reconnects: every
        // message waiting for it fails now (this one included).
        const dropped = await prisma.slackOutbox.deleteMany({ where: { orgId: row.orgId } });
        dead.add(row.orgId);
        out.failed += Math.max(dropped.count, 1);
      } else if (err?.recipientGone) {
        await prisma.slackUserLink.updateMany({
          where: { orgId: row.orgId, userId: row.userId },
          data: { status: "NO_MATCH", slackUserId: null, approvedById: null, linkedAt: null, checkedAt: now() },
        });
        await done(row.id);
        out.failed++;
      } else if ((!err || err.retryable) && row.attempts + 1 < MAX_ATTEMPTS) {
        // Slack's Retry-After when it gave one; otherwise back off, doubling from 30s.
        const wait = Math.max(err?.retryAfterMs ?? 0, 30_000 * 2 ** row.attempts);
        await prisma.slackOutbox.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now().getTime() + wait), lastError: err?.code ?? "internal" },
        });
        out.retried++;
      } else {
        await done(row.id);
        out.failed++;
      }
      if (err?.status === 429) {
        // Slack asked this org's calls to wait. No more for it in this run,
        // and its other messages wait as long (without counting a try).
        held.add(row.orgId);
        const until = new Date(now().getTime() + Math.max(err.retryAfterMs ?? 0, 30_000));
        await prisma.slackOutbox.updateMany({ where: { orgId: row.orgId, nextAttemptAt: { lt: until } }, data: { nextAttemptAt: until } });
      }
    }
  }
  for (const orgId of delivered) await recordSlackDelivery(orgId, now());
  return out;
}
