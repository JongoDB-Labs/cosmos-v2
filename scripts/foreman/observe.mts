// Daemon-side writers for the observability tables. Best-effort by contract:
// a failed observability write must NEVER take down or delay delivery, so
// every call swallows its own errors (logged to stderr for journald).
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@prisma/client";
import type { ForemanEventKind, InFlightBuild } from "@/lib/foreman/observe";

const HOST = "host";

type BreakerSnapshot = { build: number; deploy: number; tripped: boolean };

const swallow = (e: unknown): void => console.error("observe write failed:", e);

export async function boot(i: { daemonVersion: string; pid: number; workerTarget: number }): Promise<void> {
  try {
    const now = new Date();
    const fields = {
      startedAt: now, lastPassAt: now, daemonVersion: i.daemonVersion, pid: i.pid,
      workerTarget: i.workerTarget, slotsBusy: 0, queueDepth: 0, inFlight: [],
      breaker: { build: 0, deploy: 0, tripped: false }, stopFileSeen: false,
    };
    await prisma.foremanState.upsert({ where: { id: HOST }, create: { id: HOST, ...fields }, update: fields });
  } catch (e) { swallow(e); }
}

export async function heartbeat(f: {
  workerTarget: number; slotsBusy: number; queueDepth: number;
  inFlight: InFlightBuild[]; breaker: BreakerSnapshot; stopFileSeen: boolean;
}): Promise<void> {
  try {
    const now = new Date();
    await prisma.foremanState.upsert({
      where: { id: HOST },
      create: {
        id: HOST, startedAt: now, lastPassAt: now, daemonVersion: "unknown", pid: process.pid,
        workerTarget: f.workerTarget, slotsBusy: f.slotsBusy, queueDepth: f.queueDepth,
        inFlight: f.inFlight, breaker: f.breaker, stopFileSeen: f.stopFileSeen,
      },
      update: { lastPassAt: now, ...f, inFlight: f.inFlight },
    });
  } catch (e) { swallow(e); }
}

type TrackEvent = {
  workItemId?: string; orgId?: string; ticketKey?: string;
  kind: ForemanEventKind; severity?: "info" | "warn" | "error";
  message: string; data?: Record<string, unknown>;
};

/** Write a foreman_event, THROWING on failure. For the load-bearing events whose
 *  absence changes behavior — e.g. the `planned` event getDemotionFacts keys
 *  demotion protection off — the caller must know the write failed. Best-effort
 *  callers use `track` (below), which is this with the throw swallowed. */
export async function trackStrict(ev: TrackEvent): Promise<void> {
  let orgId = ev.orgId ?? null;
  if (!orgId && ev.workItemId) {
    const wi = await prisma.workItem.findUnique({ where: { id: ev.workItemId }, select: { orgId: true } });
    orgId = wi?.orgId ?? null;
  }
  await prisma.foremanEvent.create({
    data: {
      orgId, workItemId: ev.workItemId ?? null, ticketKey: ev.ticketKey ?? null,
      kind: ev.kind, severity: ev.severity ?? "info", message: ev.message,
      data: (ev.data ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Best-effort event write: `trackStrict` with the failure swallowed (logged to
 *  stderr for journald) — the contract every existing caller relies on, so a
 *  failed observability write can never take down or delay delivery. */
export async function track(ev: TrackEvent): Promise<void> {
  return trackStrict(ev).catch(swallow);
}
