// Server-side assembly of the Foreman console payload. Read-only.
import { prisma } from "@/lib/db/client";
import { readAutomationConfig } from "@/lib/feedback/automation-config";
import { pulseFor, type InFlightBuild } from "@/lib/foreman/observe";

export type ForemanStatusPayload = {
  state: null | {
    pulse: ReturnType<typeof pulseFor>;
    lastPassAt: string; startedAt: string; daemonVersion: string;
    workerTarget: number; slotsBusy: number; queueDepth: number;
    breaker: { build: number; deploy: number; tripped: boolean };
    stopFileSeen: boolean;
  };
  paused: boolean;
  inFlight: InFlightBuild[];
  awaitingApproval: { workItemId: string; ticketKey: string | null; title: string; reason: string | null; prUrl: string | null; parkedAt: string }[];
  config: ReturnType<typeof readAutomationConfig>;
  hasHistory: boolean;
};

export async function assembleStatus(orgId: string): Promise<ForemanStatusPayload> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
  const config = readAutomationConfig(org?.settings ?? {});
  const paused = !config.autonomousDelivery.enabled;

  const row = await prisma.foremanState.findUnique({ where: { id: "host" } });
  const breaker = (row?.breaker ?? { build: 0, deploy: 0, tripped: false }) as { build: number; deploy: number; tripped: boolean };
  const allInFlight = ((row?.inFlight ?? []) as InFlightBuild[]);
  const state = row
    ? {
        pulse: pulseFor({ lastPassAt: row.lastPassAt, paused, breakerTripped: breaker.tripped, stopFileSeen: row.stopFileSeen }),
        lastPassAt: row.lastPassAt.toISOString(), startedAt: row.startedAt.toISOString(),
        daemonVersion: row.daemonVersion, workerTarget: row.workerTarget,
        slotsBusy: row.slotsBusy, queueDepth: row.queueDepth, breaker, stopFileSeen: row.stopFileSeen,
      }
    : null;

  const projectIds = config.autonomousDelivery.projectIds;
  const parked = projectIds.length
    ? await prisma.workItem.findMany({
        where: { orgId, projectId: { in: projectIds }, columnKey: "review" },
        select: { id: true, title: true, columnEnteredAt: true },
        orderBy: { columnEnteredAt: "desc" },
        take: 50,
      })
    : [];
  const awaitingApproval = await Promise.all(
    parked.map(async (wi) => {
      const ev = await prisma.foremanEvent.findFirst({
        where: { workItemId: wi.id, kind: { in: ["parked", "gated", "needs-input"] } },
        orderBy: { ts: "desc" },
      });
      const data = (ev?.data ?? {}) as { reason?: string; prUrl?: string };
      return {
        workItemId: wi.id, ticketKey: ev?.ticketKey ?? null, title: wi.title,
        reason: data.reason ?? ev?.message ?? null, prUrl: data.prUrl ?? null,
        parkedAt: (wi.columnEnteredAt ?? new Date()).toISOString(),
      };
    }),
  );

  const hasHistory = (await prisma.foremanEvent.count({ where: { orgId } })) > 0;
  return { state, paused, inFlight: allInFlight.filter((b) => b.orgId === orgId), awaitingApproval, config, hasHistory };
}
