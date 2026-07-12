"use client";
// Foreman console: pulse header, in-flight builds, awaiting-approval, event feed.
// Polls status every 15s; events are cursor-paged on demand (see
// ForemanEventFeed, split out to keep this file focused).

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import type { ForemanStatusPayload } from "@/lib/foreman/status-read";
import type { Pulse, InFlightBuild } from "@/lib/foreman/observe";
import type { AutomationConfig } from "@/lib/feedback/automation-config";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { RefreshCw, ExternalLink, Pause, Play, Hammer, UserCheck, Check, ListOrdered, MessageSquarePlus } from "lucide-react";
import { ForemanMark } from "./foreman-mark";
import { ForemanEventFeed } from "./foreman-event-feed";

/** "3m ago" / "2h ago" / "5d ago" — the app has no shared relative-time
 *  helper (each consumer defines its own; see activity-feed.tsx /
 *  notification-dropdown.tsx), so this one is shared by the console and the
 *  event feed. */
export function rel(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const PULSE_LABEL: Record<Pulse, string> = {
  alive: "Active",
  idle: "Idle",
  stale: "Stale — daemon not responding",
  paused: "Paused",
  breaker: "Circuit breaker",
};

const PULSE_CLASSES: Record<Pulse, string> = {
  alive: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  idle: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  stale: "bg-red-500/15 text-red-600 dark:text-red-400",
  paused: "bg-[var(--muted)] text-[var(--text-muted)]",
  breaker: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const PHASE_LABEL: Record<InFlightBuild["phase"], string> = {
  building: "Building",
  checks: "Checks",
  repair: "Repair",
  review: "Review",
  "queued-ship": "Queued ship",
  shipping: "Shipping",
};

const PHASE_VARIANT: Record<InFlightBuild["phase"], BadgeVariant> = {
  building: "progress",
  checks: "discovery",
  repair: "blocked",
  review: "review",
  "queued-ship": "strategic",
  shipping: "progress",
};

export function ForemanConsole({ orgId }: { orgId: string }) {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const qc = useQueryClient();
  const statusKey = useOrgQueryKey("foreman-status");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: statusKey,
    queryFn: () => jsonFetch<ForemanStatusPayload>(`/api/v1/orgs/${orgId}/foreman/status`),
    refetchInterval: 15_000,
  });

  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);
  const [rework, setRework] = useState<{ workItemId: string; projectId: string; ticketKey: string | null } | null>(null);
  const [reworkText, setReworkText] = useState("");

  // Pause/resume PUTs the FULL automation config back (both blocks) — same
  // contract as the settings form — flipping only autonomousDelivery.enabled.
  const toggleDelivery = useOrgMutation<AutomationConfig, Error, boolean>({
    mutationFn: (nextEnabled) => {
      const cfg = data?.config;
      if (!cfg) throw new Error("Foreman status hasn't loaded yet.");
      return jsonFetch<AutomationConfig>(`/api/v1/orgs/${orgId}/feedback/remediation-config`, {
        method: "PUT",
        body: JSON.stringify({
          autoRemediation: cfg.autoRemediation,
          autonomousDelivery: { ...cfg.autonomousDelivery, enabled: nextEnabled },
        }),
      });
    },
    invalidate: [["foreman-status"]],
    onSuccess: (_res, nextEnabled) => {
      toast.success(nextEnabled ? "Autonomous delivery resumed" : "Autonomous delivery paused");
    },
  });

  // Posts a plain "approve" comment on the ticket's own thread — the SAME
  // route/schema the ticket sheet's comment box uses — as the acting
  // (logged-in) user. The decision lives in the ticket's audit trail; the
  // daemon reads it on its next pass (≤60s) and merges the built PR.
  const approve = useOrgMutation<unknown, Error, { workItemId: string; projectId: string }>({
    mutationFn: ({ workItemId, projectId }) =>
      jsonFetch<unknown>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/work-items/${workItemId}/comments`,
        { method: "POST", body: JSON.stringify({ content: "approve" }) },
      ),
    invalidate: [["foreman-status"]],
    onSuccess: () => {
      toast.success("Approved — Foreman merges & deploys on its next pass (≤1 min)");
    },
  });

  // Same comments-route mutation as `approve`, but with user-typed follow-up
  // instructions instead of the fixed "approve" string. Foreman treats it as
  // any other ticket comment — reads it on its next pass and resumes.
  const sendRework = useOrgMutation<unknown, Error, { workItemId: string; projectId: string; content: string }>({
    mutationFn: ({ workItemId, projectId, content }) =>
      jsonFetch<unknown>(
        `/api/v1/orgs/${orgId}/projects/${projectId}/work-items/${workItemId}/comments`,
        { method: "POST", body: JSON.stringify({ content }) },
      ),
    invalidate: [["foreman-status"]],
    onSuccess: () => {
      toast.success("Sent — Foreman picks it up on its next pass (≤1 min)");
      setReworkText("");
      setRework(null);
    },
  });

  // Pulls a `review`-parked ticket back to `backlog`, discarding the current
  // build for a fresh one. Patches the status cache immediately so the card
  // disappears without waiting on the invalidate round-trip, then
  // invalidates to reconcile with the server.
  const rebuild = useOrgMutation<{ ok: boolean }, Error, string>({
    mutationFn: (workItemId) =>
      jsonFetch<{ ok: boolean }>(`/api/v1/orgs/${orgId}/foreman/requeue`, {
        method: "POST",
        body: JSON.stringify({ workItemId }),
      }),
    invalidate: [["foreman-status"], ["foreman-events"]],
    onSuccess: (_res, workItemId) => {
      qc.setQueryData<ForemanStatusPayload>(statusKey, (old) =>
        old
          ? { ...old, awaitingApproval: old.awaitingApproval.filter((a) => a.workItemId !== workItemId) }
          : old,
      );
      toast.success("Rebuild queued — a fresh pass starts shortly.");
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return <LoadError title="Couldn't load the Foreman console" onRetry={() => refetch()} />;
  }

  // `state` is null until the daemon's first heartbeat ever lands — fall back
  // to the config-level `paused` flag so the pill still reads correctly with
  // no live state (pulseFor treats a never-seen daemon as stale otherwise).
  const pulse: Pulse = data.state?.pulse ?? (data.paused ? "paused" : "stale");

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <ForemanMark className="size-5 text-[var(--primary)]" />
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", PULSE_CLASSES[pulse])}>
              {PULSE_LABEL[pulse]}
            </span>
          </div>
          {data.paused ? (
            <Button size="sm" onClick={() => toggleDelivery.mutate(true)} disabled={toggleDelivery.isPending}>
              <Play className="size-3.5" /> Resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPauseDialogOpen(true)}
              disabled={toggleDelivery.isPending}
            >
              <Pause className="size-3.5" /> Pause
            </Button>
          )}
        </div>
        {data.state ? (
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            last pass {rel(data.state.lastPassAt)} · daemon v{data.state.daemonVersion} · workers{" "}
            {data.state.slotsBusy}/{data.state.workerTarget} · queue {data.state.queueDepth}
          </p>
        ) : (
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            {data.hasHistory
              ? "No live daemon state right now — it may be between passes or just restarted."
              : "The Foreman daemon hasn't run yet."}
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Foreman works the board left to right: Backlog (open pool) → To-do (planned up next) →
          In progress → Review (parked for you) → Done (shipped). Move a ticket back to To-do or
          Backlog to have it reworked — comments ride along.
        </p>
      </div>

      <Dialog open={pauseDialogOpen} onOpenChange={setPauseDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause autonomous delivery?</DialogTitle>
            <DialogDescription>
              The daemon finishes anything already in flight, then stops claiming new tickets until
              you resume. Nothing in progress is discarded.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPauseDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                toggleDelivery.mutate(false);
                setPauseDialogOpen(false);
              }}
              disabled={toggleDelivery.isPending}
            >
              <Pause className="size-3.5" /> Pause
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SectionCard
        icon={ListOrdered}
        title="Up next"
        description="Foreman's planned queue — To-do tickets in claim order. Curate it by moving tickets on the board."
      >
        {data.upNext.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            Nothing planned yet — Foreman promotes the highest-priority backlog tickets here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  <th className="py-2 pr-4 font-medium">Ticket</th>
                  <th className="py-2 pr-4 font-medium">Title</th>
                  <th className="py-2 pr-4 font-medium">Why</th>
                  <th className="py-2 text-right font-medium">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {data.upNext.map((u) => (
                  <tr key={u.workItemId}>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/${orgSlug}/issues?item=${u.workItemId}`}
                        className="font-mono text-xs text-[var(--primary)] hover:underline"
                      >
                        {u.ticketKey ?? "—"}
                      </Link>
                    </td>
                    <td className="max-w-xs truncate py-2 pr-4">{u.title}</td>
                    <td className="max-w-xs truncate py-2 pr-4 text-[var(--text-muted)]">{u.why ?? "—"}</td>
                    <td className="py-2 text-right text-[var(--text-muted)]">{rel(u.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* In-flight builds — may show MORE rows than state.slotsBusy: a
          queued-ship/shipping item holds no build slot but still occupies a
          row here. Render exactly what the payload says; never clamp. */}
      <SectionCard icon={Hammer} title="In flight" description="Builds a worker slot is holding right now.">
        {data.inFlight.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No builds in flight.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  <th className="py-2 pr-4 font-medium">Ticket</th>
                  <th className="py-2 pr-4 font-medium">Title</th>
                  <th className="py-2 pr-4 font-medium">Phase</th>
                  <th className="py-2 pr-4 font-medium">Elapsed</th>
                  <th className="py-2 text-right font-medium">Round</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {data.inFlight.map((b) => (
                  <tr key={b.key}>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/${orgSlug}/issues?item=${b.itemId}`}
                        className="font-mono text-xs text-[var(--primary)] hover:underline"
                      >
                        {b.key}
                      </Link>
                    </td>
                    <td className="max-w-xs truncate py-2 pr-4">{b.title}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={PHASE_VARIANT[b.phase]} showDot={false}>
                        {PHASE_LABEL[b.phase]}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-[var(--text-muted)]">{rel(b.since)}</td>
                    <td className="py-2 text-right tabular-nums text-[var(--text-muted)]">
                      {b.repairRound ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        icon={UserCheck}
        title="Awaiting approval"
        description="Risky changes parked for a human decision before they ship."
      >
        {data.awaitingApproval.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Nothing is waiting on your approval.</p>
        ) : (
          <ul className="space-y-3">
            {data.awaitingApproval.map((a) => (
              <li key={a.workItemId} className="rounded-md border border-[var(--border)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {a.ticketKey && (
                        <span className="font-mono text-xs text-[var(--text-muted)]">{a.ticketKey}</span>
                      )}
                      <span className="font-medium text-[var(--text)]">{a.title}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--text-muted)]">
                      {a.reason ?? "No reason recorded."}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {a.prUrl && (
                      <a
                        href={a.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                      >
                        <ExternalLink className="size-3.5" /> Open PR
                      </a>
                    )}
                    {/* Steering (Approve / Rebuild) is a BASE OWNER/ADMIN privilege —
                        matches the daemon's own gate. A non-steward sees the card
                        (Open PR, reason) read-only, no levers. */}
                    {data.actorCanSteer && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rebuild.isPending && rebuild.variables === a.workItemId}
                          onClick={() => {
                            if (
                              !window.confirm(
                                "Rebuild this ticket? Foreman discards the current build and queues a fresh pass.",
                              )
                            )
                              return;
                            rebuild.mutate(a.workItemId);
                          }}
                        >
                          <RefreshCw className="size-3.5" /> Rebuild
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRework({ workItemId: a.workItemId, projectId: a.projectId, ticketKey: a.ticketKey });
                            setReworkText("");
                          }}
                        >
                          <MessageSquarePlus className="size-3.5" /> Rework
                        </Button>
                        <Button
                          size="sm"
                          disabled={!a.prUrl || (approve.isPending && approve.variables?.workItemId === a.workItemId)}
                          title={!a.prUrl ? "Nothing built yet — comment instructions on the ticket or Rebuild" : undefined}
                          onClick={() => {
                            // Approve deploys to prod — confirm first, mirroring Rebuild.
                            if (
                              !window.confirm(
                                `Merge and deploy ${a.ticketKey ?? "this ticket"}? Foreman handles the rest.`,
                              )
                            )
                              return;
                            approve.mutate({ workItemId: a.workItemId, projectId: a.projectId });
                          }}
                        >
                          <Check className="size-3.5" /> Approve
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                  Approve merges the built PR and deploys it. Rework sends follow-up instructions —
                  Foreman resumes right where it left off. Comments on the ticket work too.
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Dialog
        open={rework !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRework(null);
            setReworkText("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rework {rework?.ticketKey ?? "ticket"}</DialogTitle>
            <DialogDescription>
              Foreman resumes its previous session on this ticket with your notes and pushes an
              updated build for approval.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={reworkText}
            onChange={(e) => setReworkText(e.target.value)}
            placeholder="What should change?"
            rows={4}
            className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRework(null);
                setReworkText("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!reworkText.trim() || sendRework.isPending}
              onClick={() => {
                if (!rework) return;
                sendRework.mutate({ workItemId: rework.workItemId, projectId: rework.projectId, content: reworkText.trim() });
              }}
            >
              <MessageSquarePlus className="size-3.5" /> Send to Foreman
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ForemanEventFeed orgId={orgId} />
    </div>
  );
}
