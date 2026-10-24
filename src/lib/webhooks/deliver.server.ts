/**
 * Send queued webhook deliveries (the outbox worker queues them, see
 * src/lib/automation/outbox.server.ts), retrying a failure with backoff.
 *
 * A run leases a batch of due PENDING deliveries (FOR UPDATE SKIP LOCKED, then
 * moves their next_attempt_at past the lease), commits, and only then sends,
 * so no row lock is held across a slow endpoint and a second sender skips
 * what this one took. A sender that dies mid-send leaves its leased rows to
 * come due again when the lease runs out: a receiver can see one delivery
 * twice, which is why each carries X-Webhook-Delivery to deduplicate on.
 *
 * Every send goes through postToPublicUrl: resolved, checked and pinned at
 * send time, no redirects.
 */
import { createHmac } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { openFieldWithHeal } from "@/lib/crypto/field-seal";
import { OutboundRefused, postToPublicUrl, type OutboundResult } from "@/lib/security/outbound-post.server";

/** Wait before attempt n+1 after attempt n failed (index n). Six attempts in all, over about 14 hours. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** How long a leased delivery stays out of other senders' reach. */
const LEASE_MS = 5 * 60_000;

export type Post = (url: string, opts: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<OutboundResult>;

export interface DeliveryRun {
  sent: number;
  succeeded: number;
  /** Will be retried. */
  retrying: number;
  /** Out of attempts, or the webhook is switched off. */
  failed: number;
}

/** The signed request a delivery sends: the body and the headers that sign it. */
export function signedRequest(opts: { event: string; deliveryId: string; attempt: number; payload: unknown; secret: string; now: Date }) {
  const body = JSON.stringify({ event: opts.event, timestamp: opts.now.toISOString(), data: opts.payload });
  const signature = createHmac("sha256", opts.secret).update(body).digest("hex");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Cosmos-Webhooks/1",
      "X-Webhook-Signature": `sha256=${signature}`,
      "X-Webhook-Event": opts.event,
      "X-Webhook-Delivery": opts.deliveryId,
      "X-Webhook-Attempt": String(opts.attempt),
    },
  };
}

export async function sendDueDeliveries(
  db: PrismaClient,
  opts: { limit?: number; now?: () => Date; signal?: AbortSignal; post?: Post } = {},
): Promise<DeliveryRun> {
  const now = opts.now ?? (() => new Date());
  const post = opts.post ?? postToPublicUrl;
  const leaseAt = now();
  const leased = await db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhook_deliveries
      WHERE status = 'PENDING' AND next_attempt_at <= ${leaseAt}
      ORDER BY next_attempt_at
      LIMIT ${opts.limit ?? 25}
      FOR UPDATE SKIP LOCKED
    `;
    if (due.length === 0) return [];
    const ids = due.map((d) => d.id);
    await tx.webhookDelivery.updateMany({ where: { id: { in: ids } }, data: { nextAttemptAt: new Date(leaseAt.getTime() + LEASE_MS) } });
    return tx.webhookDelivery.findMany({
      where: { id: { in: ids } },
      select: { id: true, event: true, payload: true, attempts: true, webhook: { select: { id: true, url: true, secret: true, active: true } } },
    });
  });

  const run: DeliveryRun = { sent: 0, succeeded: 0, retrying: 0, failed: 0 };
  // A few at a time: one slow endpoint shouldn't hold up the rest, nor should a
  // batch open 25 connections at once.
  for (let i = 0; i < leased.length && !opts.signal?.aborted; i += 5) {
    await Promise.all(leased.slice(i, i + 5).map(async (d) => {
      const attempt = d.attempts + 1;
      if (!d.webhook.active) {
        await db.webhookDelivery.update({ where: { id: d.id }, data: { status: "FAILED", nextAttemptAt: null, responseBody: "Not sent: the webhook is switched off." } });
        run.failed++;
        return;
      }
      let outcome: { ok: boolean; statusCode: number | null; body: string };
      try {
        const secret = await openFieldWithHeal(d.webhook.secret, async (sealed) => {
          await db.webhook.update({ where: { id: d.webhook.id }, data: { secret: sealed } });
        });
        const req = signedRequest({ event: d.event, deliveryId: d.id, attempt, payload: d.payload, secret, now: now() });
        const res = await post(d.webhook.url, { ...req, signal: opts.signal });
        outcome = { ok: res.status >= 200 && res.status < 300, statusCode: res.status, body: res.body };
        if (res.status >= 300 && res.status < 400) outcome.body = `Redirect (${res.status}) not followed. ${res.body}`.slice(0, 1000);
      } catch (e) {
        outcome = { ok: false, statusCode: null, body: (e instanceof OutboundRefused || e instanceof Error ? e.message : "Unknown error").slice(0, 1000) };
      }
      run.sent++;
      const last = attempt >= MAX_ATTEMPTS;
      const at = now();
      await db.webhookDelivery.update({
        where: { id: d.id },
        data: {
          attempts: attempt,
          lastAttemptAt: at,
          statusCode: outcome.statusCode,
          responseBody: outcome.body,
          status: outcome.ok ? "SUCCESS" : last ? "FAILED" : "PENDING",
          nextAttemptAt: outcome.ok || last ? null : new Date(at.getTime() + RETRY_DELAYS_MS[attempt - 1]),
        },
      });
      if (outcome.ok) run.succeeded++;
      else if (last) run.failed++;
      else run.retrying++;
    }));
  }
  return run;
}
