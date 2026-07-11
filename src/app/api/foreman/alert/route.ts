import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, handleApiError } from "@/lib/api-helpers";
import { readAutomationConfig } from "@/lib/feedback/automation-config";
import { notifyOrgOwners } from "@/lib/feedback/delivery-notify";

const alertSchema = z.object({
  check: z.enum(["stale", "unit-failure"]),
  lastPassAt: z.string().optional(),
});

/** Same window the daemon's own dedup logic favors elsewhere — long enough that
 *  a flapping watchdog (cron retries, transient network blips) can't spam every
 *  org's owners once per check interval, short enough that a NEW outage still
 *  pages within the hour it starts mattering. */
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Constant-time bearer compare against `FOREMAN_ALERT_TOKEN` — same shape as
 *  the API-key hash compare in `@/lib/auth/api-key.ts` (length-check first;
 *  `timingSafeEqual` throws on mismatched buffer lengths rather than
 *  returning false). */
function bearerMatches(request: NextRequest, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Dead-man's-switch endpoint for the Foreman daemon: an external watchdog
 * (cron / uptime check, outside this app) posts here when the daemon looks
 * down — a stale heartbeat or a unit-test failure on the delivery host — so
 * owners hear about the outage even though the thing that would normally tell
 * them (Foreman's own event feed) is what's broken. Deliberately NOT org-
 * scoped and NOT session-authed: it fires with no request-time org context and
 * needs to work even if every session/cookie path is unhealthy. Guarded by a
 * single shared secret instead (`FOREMAN_ALERT_TOKEN`, read fresh per request
 * so ops can rotate it without a restart), and deduped so a flapping watchdog
 * can't re-page every org on every retry.
 */
export async function POST(request: NextRequest) {
  try {
    const token = process.env.FOREMAN_ALERT_TOKEN;
    if (!token) return new Response("Foreman alert token not configured", { status: 503 });
    if (!bearerMatches(request, token)) return new Response("Unauthorized", { status: 401 });

    const { check, lastPassAt } = alertSchema.parse(await request.json());

    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const recent = await prisma.foremanEvent.findFirst({
      where: { kind: "error", ts: { gt: since }, data: { path: ["check"], equals: check } },
      select: { id: true },
    });
    if (recent) return success({ deduped: true });

    const message = `check: ${check}${lastPassAt ? ` — last pass ${lastPassAt}` : ""}`;

    // Org-less daemon-level row (mirrors the daemon's own "breaker" events) —
    // this isn't scoped to any one org, so `events/route.ts` only surfaces it
    // to orgs with delivery enabled.
    await prisma.foremanEvent.create({
      data: {
        kind: "error",
        severity: "error",
        message,
        data: { check, lastPassAt: lastPassAt ?? null },
      },
    });

    const orgs = await prisma.organization.findMany({ select: { id: true, settings: true } });
    for (const org of orgs) {
      if (!readAutomationConfig(org.settings).autonomousDelivery.enabled) continue;
      await notifyOrgOwners(org.id, { title: "Foreman appears down", message, url: "/" });
    }

    return success({ deduped: false });
  } catch (e) {
    return handleApiError(e);
  }
}
