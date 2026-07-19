"use client";
// Foreman console: pulse header, in-flight builds, awaiting-approval, event feed.
// Polls status every 15s; events are cursor-paged on demand (see
// ForemanEventFeed, split out to keep this file focused).

import { useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { useForemanRealtime } from "@/hooks/use-foreman-realtime";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { RefreshCw, ExternalLink, Pause, Play, Hammer, UserCheck, Check, ListOrdered, MessageSquarePlus, Sparkles, ShieldCheck, Layers } from "lucide-react";
import { ForemanMark } from "./foreman-mark";
import { ForemanEventFeed } from "./foreman-event-feed";
import { ForemanClaudePanel } from "./foreman-claude-panel";
import { ForemanGithubPanel } from "./foreman-github-panel";
import { ForemanSupervisorPanel } from "./foreman-supervisor-panel";

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

/** Per-control tooltip copy — states exactly what each button does. Rework and
 *  Rebuild are deliberately contrasted ("resumes the existing build" vs
 *  "discards it and starts fresh") so the two are never confused. */
const CONTROL_TOOLTIP = {
  pause: "Disables autonomous delivery — the daemon finishes any in-flight work, then stops claiming new tickets until you resume.",
  resume: "Re-enables autonomous delivery — the daemon starts claiming and shipping tickets again.",
  approve:
    "On its next pass, Foreman merges the draft PR to main, tags the version, waits for the signed CI image, and DEPLOYS to live production (health-gated, auto-rollback).",
  rebuild: "Discards the current build and starts a fresh pass from scratch (does NOT keep your guidance).",
  rework: "Posts your notes as an @Foreman instruction so the daemon resumes the EXISTING build with your guidance — it does not start over.",
  linkPr: "Opens the GitHub pull request (read-only).",
  aiAnalysis:
    "Analyzes this PR's diff against the ticket's requirements and acceptance criteria — per-criterion coverage, gaps, and risks. Runs on Foreman's own subscription.",
  aiAnalysisDisabled: "Nothing to analyze — the agent produced no pull request.",
} as const;

/** Coordinated-epic aggregate status → badge variant + label (COSMOS-118/-126). */
const COORD_STATUS: Record<
  ForemanStatusPayload["coordinatedEpics"][number]["status"],
  { label: string; variant: BadgeVariant }
> = {
  incremental: { label: "Incremental", variant: "discovery" },
  holding: { label: "Holding", variant: "review" },
  shipping: { label: "Shipping", variant: "strategic" },
  blocked: { label: "Blocked", variant: "blocked" },
};

const PHASE_VARIANT: Record<InFlightBuild["phase"], BadgeVariant> = {
  building: "progress",
  checks: "discovery",
  repair: "blocked",
  review: "review",
  "queued-ship": "strategic",
  shipping: "progress",
};

/** Per-item AI recommendation (COSMOS-111): a "Recommend: Approve/Rework/Rebuild"
 *  badge + one-line rationale on each awaiting-approval card. No-PR items are a
 *  fixed Rebuild rendered client-side (nothing was built); PR-backed items fetch
 *  a Claude analysis of the actual PR, cached server-side per PR head SHA. */
type RecommendationKind = "approve" | "rework" | "rebuild";

interface RecommendationResponse {
  recommendation: RecommendationKind;
  rationale: string;
  cached: boolean;
}

const REC_LABEL: Record<RecommendationKind, string> = {
  approve: "Approve",
  rework: "Rework",
  rebuild: "Rebuild",
};

const REC_VARIANT: Record<RecommendationKind, BadgeVariant> = {
  approve: "done",
  rework: "review",
  rebuild: "blocked",
};

// Mirrors NO_PR_RECOMMENDATION.rationale in src/lib/foreman/approval-recommendation.ts.
// Kept as a local literal so this client component never imports that server module.
const NO_PR_REBUILD_RATIONALE = "Nothing was built to approve — the agent produced no pull request.";

function RecRow({
  recommendation,
  rationale,
}: {
  recommendation: RecommendationKind;
  rationale: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-start gap-x-2 gap-y-1">
      <Badge variant={REC_VARIANT[recommendation]} showDot={false} className="shrink-0">
        Recommend: {REC_LABEL[recommendation]}
      </Badge>
      <span className="text-xs text-[var(--text-muted)]">{rationale}</span>
    </div>
  );
}

function ApprovalRecommendation({
  orgId,
  workItemId,
  prUrl,
  canSteer,
}: {
  orgId: string;
  workItemId: string;
  prUrl: string | null;
  canSteer: boolean;
}) {
  const recKey = useOrgQueryKey("foreman-recommendation", workItemId);
  // Only PR-backed cards visible to a steward hit the (paid) analysis endpoint —
  // a no-PR card is a fixed client-side Rebuild, and a non-steward can't run it.
  const enabled = Boolean(prUrl) && canSteer;
  const { data, isLoading, isError } = useQuery({
    queryKey: recKey,
    queryFn: () =>
      jsonFetch<RecommendationResponse>(
        `/api/v1/orgs/${orgId}/foreman/approval-recommendation?workItemId=${workItemId}`,
      ),
    enabled,
    // Cached server-side per PR head SHA; keep the client copy stable across the
    // 15s status poll rather than re-requesting on every render.
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });

  // No PR → nothing was built: a fixed Rebuild, no request.
  if (!prUrl) return <RecRow recommendation="rebuild" rationale={NO_PR_REBUILD_RATIONALE} />;
  // A non-steward viewer sees the card read-only and can't spend Foreman's tokens.
  if (!canSteer) return null;
  if (isLoading) {
    return (
      <div className="mt-3">
        <Skeleton className="h-4 w-56" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <RecRow
        recommendation="rework"
        rationale="Couldn't analyze the PR automatically — open it and review the diff yourself."
      />
    );
  }
  return <RecRow recommendation={data.recommendation} rationale={data.rationale} />;
}

/** Per-item AI requirements analysis (COSMOS-116): an expandable report judging
 *  the PR diff against the ORIGINAL ticket's description + acceptance criteria —
 *  per-criterion met/partial/missing, gaps, risks, and whether it's complete.
 *  Fetched on expand and cached server-side per PR head SHA (and client-side for
 *  5 min) so the 15s status poll never recomputes it. Only mounted for a
 *  PR-backed card a steward has expanded — no-PR cards disable the trigger. */
type CriterionStatus = "met" | "partial" | "missing";

interface CriterionAssessment {
  criterion: string;
  status: CriterionStatus;
  note: string;
}

interface RequirementsAnalysisResponse {
  summary: string;
  criteria: CriterionAssessment[];
  gaps: string[];
  risks: string[];
  complete: boolean;
  cached: boolean;
}

const CRITERION_LABEL: Record<CriterionStatus, string> = {
  met: "Met",
  partial: "Partial",
  missing: "Missing",
};

const CRITERION_VARIANT: Record<CriterionStatus, BadgeVariant> = {
  met: "done",
  partial: "review",
  missing: "blocked",
};

function AnalysisList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--text-muted)]">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function RequirementsAnalysisPanel({ orgId, workItemId }: { orgId: string; workItemId: string }) {
  const key = useOrgQueryKey("foreman-requirements-analysis", workItemId);
  const { data, isLoading, isError } = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<RequirementsAnalysisResponse>(
        `/api/v1/orgs/${orgId}/foreman/requirements-analysis?workItemId=${workItemId}`,
      ),
    // Cached server-side per PR head SHA; keep the client copy stable across the
    // 15s status poll rather than re-requesting on every render.
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });

  const wrap = "mt-3 rounded-md border border-[var(--border)] bg-[var(--muted)]/40 p-3";

  if (isLoading) {
    return (
      <div className={cn(wrap, "space-y-2")}>
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className={cn(wrap, "text-sm text-[var(--text-muted)]")}>
        Couldn&apos;t analyze the PR automatically — open it and review the diff against the ticket
        yourself.
      </div>
    );
  }

  return (
    <div className={cn(wrap, "space-y-3")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={data.complete ? "done" : "review"} showDot={false} className="shrink-0">
          {data.complete ? "Complete" : "Incomplete"}
        </Badge>
        <span className="text-sm text-[var(--text)]">{data.summary}</span>
      </div>

      {data.criteria.length > 0 && (
        <ul className="space-y-1.5">
          {data.criteria.map((c, i) => (
            <li key={i} className="flex flex-wrap items-start gap-x-2 gap-y-1">
              <Badge variant={CRITERION_VARIANT[c.status]} showDot={false} className="shrink-0">
                {CRITERION_LABEL[c.status]}
              </Badge>
              <span className="min-w-0 text-sm text-[var(--text)]">
                <span className="font-medium">{c.criterion}</span>
                {c.note ? <span className="text-[var(--text-muted)]"> — {c.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <AnalysisList title="Gaps" items={data.gaps} />
      <AnalysisList title="Risks" items={data.risks} />
    </div>
  );
}

/** Intake decisions surfaced on the console (COSMOS-121, Phase 3c) — mirrors the
 *  Feedback board's `intake` descriptor so a steward can see, in one place, what
 *  the guardrail pipeline accepted vs. pulled aside (and why) before anything
 *  reached the build queue. Reads the org's feedback list (ORG_READ) and shows
 *  only items that have been through intake, parks first. */
type IntakeState = "accepted" | "held" | "rejected" | "throttled" | "gated";

interface IntakeDecision {
  state: IntakeState;
  label: string;
  reason: string;
  score: number | null;
}

interface FeedbackListItem {
  id: string;
  type: "BUG" | "FEATURE";
  title: string;
  intake?: IntakeDecision | null;
}

const INTAKE_VARIANT: Record<IntakeState, BadgeVariant> = {
  accepted: "done",
  held: "review",
  rejected: "blocked",
  throttled: "neutral",
  gated: "review",
};

// Parks (a person may need to act) sort above already-accepted items.
const INTAKE_SORT: Record<IntakeState, number> = {
  rejected: 0,
  held: 1,
  gated: 2,
  throttled: 3,
  accepted: 4,
};

function IntakeDecisions({ orgId }: { orgId: string }) {
  const key = useOrgQueryKey("feedback-intake-decisions");
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<FeedbackListItem[]>(`/api/v1/orgs/${orgId}/feedback`),
    // Realtime (feedback.* events, see ForemanConsole) drives freshness now — a
    // slow poll only backstops a dropped SSE / reconnect (COSMOS-127).
    refetchInterval: 60_000,
  });

  const decided = (Array.isArray(data) ? data : [])
    .filter((i): i is FeedbackListItem & { intake: IntakeDecision } => Boolean(i.intake))
    .sort((a, b) => INTAKE_SORT[a.intake.state] - INTAKE_SORT[b.intake.state])
    .slice(0, 12);

  return (
    <SectionCard
      icon={ShieldCheck}
      title="Intake decisions"
      description="What the feedback guardrails accepted or pulled aside before the build queue."
    >
      {decided.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No intake decisions recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {decided.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant={INTAKE_VARIANT[i.intake.state]} showDot={false} className="shrink-0">
                    {i.intake.label}
                    {i.intake.score != null ? ` · ${i.intake.score.toFixed(2)}` : ""}
                  </Badge>
                  <span className="truncate text-sm text-[var(--text)]">{i.title}</span>
                </div>
                <p className="mt-0.5 line-clamp-1 text-xs text-[var(--text-muted)]">{i.intake.reason}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function ForemanConsole({ orgId }: { orgId: string }) {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const qc = useQueryClient();
  const statusKey = useOrgQueryKey("foreman-status");
  const eventsKey = useOrgQueryKey("foreman-events");
  const intakeKey = useOrgQueryKey("feedback-intake-decisions");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: statusKey,
    queryFn: () => jsonFetch<ForemanStatusPayload>(`/api/v1/orgs/${orgId}/foreman/status`),
    // Realtime keeps the console live (see useForemanRealtime below); the poll is
    // now just a slow reconnect/backstop for daemon-state-only changes that emit
    // no work-item event, not the primary freshness path (COSMOS-127).
    refetchInterval: 60_000,
  });

  // Live console (COSMOS-127): any board move the daemon drives (Approve /
  // Rework / Rebuild → next column) or feedback intake decision refreshes the
  // status payload, event feed, and intake list the instant it publishes — no
  // waiting on the poll. Debounced so a burst of events coalesces into one pass.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useForemanRealtime(orgId, () => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: statusKey });
      void qc.invalidateQueries({ queryKey: eventsKey });
      void qc.invalidateQueries({ queryKey: intakeKey });
    }, 300);
  });

  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [rework, setRework] = useState<{ workItemId: string; projectId: string; ticketKey: string | null } | null>(null);
  const [reworkText, setReworkText] = useState("");
  // Approve/Rebuild each open a proper confirmation Dialog (was window.confirm).
  // A single shared dialog per action tracks which parked card triggered it.
  const [approveTarget, setApproveTarget] = useState<{ workItemId: string; projectId: string; ticketKey: string | null } | null>(null);
  const [rebuildTarget, setRebuildTarget] = useState<{ workItemId: string; ticketKey: string | null } | null>(null);
  // Per-card AI Analysis (COSMOS-116): which parked cards have the requirements
  // report expanded. Keyed by workItemId so several can be open independently.
  const [analysisOpen, setAnalysisOpen] = useState<Record<string, boolean>>({});

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
    <TooltipProvider>
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="sm" onClick={() => setResumeDialogOpen(true)} disabled={toggleDelivery.isPending} />
                }
              >
                <Play className="size-3.5" /> Resume
              </TooltipTrigger>
              <TooltipContent>{CONTROL_TOOLTIP.resume}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPauseDialogOpen(true)}
                    disabled={toggleDelivery.isPending}
                  />
                }
              >
                <Pause className="size-3.5" /> Pause
              </TooltipTrigger>
              <TooltipContent>{CONTROL_TOOLTIP.pause}</TooltipContent>
            </Tooltip>
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

      <Dialog open={resumeDialogOpen} onOpenChange={setResumeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resume autonomous delivery?</DialogTitle>
            <DialogDescription>
              Re-enables autonomous delivery — the daemon starts claiming new tickets and shipping
              builds again on its next pass.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResumeDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                toggleDelivery.mutate(true);
                setResumeDialogOpen(false);
              }}
              disabled={toggleDelivery.isPending}
            >
              <Play className="size-3.5" /> Resume
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin section — Foreman's own Claude subscription. This page is
          already OWNER/ADMIN-gated (see foreman/page.tsx's canManage check),
          so no extra permission gate is needed here. */}
      <ForemanClaudePanel orgId={orgId} />
      <ForemanGithubPanel orgId={orgId} />
      <ForemanSupervisorPanel orgId={orgId} />

      <IntakeDecisions orgId={orgId} />

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
                    {/* || not ??: a planner pick missing its why stores "" — dash both. */}
                    <td className="max-w-xs truncate py-2 pr-4 text-[var(--text-muted)]">{u.why || "—"}</td>
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
                      {b.detail ? (
                        <span className="ml-2 text-xs text-[var(--text-muted)]">{b.detail}</span>
                      ) : null}
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

      {/* Coordinated releases (COSMOS-118/-126): each opted-in epic's phase
          readiness and whether its single coordinated release is holding,
          shipping, or blocked. Only rendered when there's at least one. */}
      {data.coordinatedEpics.length > 0 && (
        <SectionCard
          icon={Layers}
          title="Coordinated releases"
          description="Epics whose phases ship together as ONE version — held until every phase is green+approved."
        >
          <ul className="space-y-3">
            {data.coordinatedEpics.map((e) => (
              <li key={e.epicItemId} className="rounded-md border border-[var(--border)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/${orgSlug}/issues?item=${e.epicItemId}`}
                        className="font-mono text-xs text-[var(--primary)] hover:underline"
                      >
                        {e.epicKey}
                      </Link>
                      <span className="font-medium text-[var(--text)]">{e.title}</span>
                    </div>
                    <p className="mt-1 text-sm text-[var(--text-muted)]">
                      {e.ready}/{e.total} ready · {e.pending} pending · {e.failed} failed
                    </p>
                  </div>
                  <Badge variant={COORD_STATUS[e.status].variant} showDot={false} className="shrink-0">
                    {COORD_STATUS[e.status].label}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

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
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <a
                              href={a.prUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                            />
                          }
                        >
                          <ExternalLink className="size-3.5" /> Link to PR
                        </TooltipTrigger>
                        <TooltipContent>{CONTROL_TOOLTIP.linkPr}</TooltipContent>
                      </Tooltip>
                    )}
                    {/* Steering (Approve / Rebuild) is a BASE OWNER/ADMIN privilege —
                        matches the daemon's own gate. A non-steward sees the card
                        (Link to PR, reason) read-only, no levers. */}
                    {data.actorCanSteer && (
                      <>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!a.prUrl}
                                title={!a.prUrl ? CONTROL_TOOLTIP.aiAnalysisDisabled : undefined}
                                onClick={() =>
                                  setAnalysisOpen((m) => ({ ...m, [a.workItemId]: !m[a.workItemId] }))
                                }
                              />
                            }
                          >
                            <Sparkles className="size-3.5" /> AI Analysis
                          </TooltipTrigger>
                          <TooltipContent>
                            {a.prUrl ? CONTROL_TOOLTIP.aiAnalysis : CONTROL_TOOLTIP.aiAnalysisDisabled}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={rebuild.isPending && rebuild.variables === a.workItemId}
                                onClick={() =>
                                  setRebuildTarget({ workItemId: a.workItemId, ticketKey: a.ticketKey })
                                }
                              />
                            }
                          >
                            <RefreshCw className="size-3.5" /> Rebuild
                          </TooltipTrigger>
                          <TooltipContent>{CONTROL_TOOLTIP.rebuild}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setRework({ workItemId: a.workItemId, projectId: a.projectId, ticketKey: a.ticketKey });
                                  setReworkText("");
                                }}
                              />
                            }
                          >
                            <MessageSquarePlus className="size-3.5" /> Rework
                          </TooltipTrigger>
                          <TooltipContent>{CONTROL_TOOLTIP.rework}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="sm"
                                disabled={!a.prUrl || (approve.isPending && approve.variables?.workItemId === a.workItemId)}
                                title={!a.prUrl ? "Nothing built yet — comment instructions on the ticket or Rebuild" : undefined}
                                onClick={() =>
                                  setApproveTarget({
                                    workItemId: a.workItemId,
                                    projectId: a.projectId,
                                    ticketKey: a.ticketKey,
                                  })
                                }
                              />
                            }
                          >
                            <Check className="size-3.5" /> Approve
                          </TooltipTrigger>
                          <TooltipContent>{CONTROL_TOOLTIP.approve}</TooltipContent>
                        </Tooltip>
                      </>
                    )}
                  </div>
                </div>
                <ApprovalRecommendation
                  orgId={orgId}
                  workItemId={a.workItemId}
                  prUrl={a.prUrl}
                  canSteer={data.actorCanSteer}
                />
                {data.actorCanSteer && a.prUrl && analysisOpen[a.workItemId] && (
                  <RequirementsAnalysisPanel orgId={orgId} workItemId={a.workItemId} />
                )}
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
              Foreman RESUMES the existing build with your notes and pushes an updated build for
              approval — it does not start over. (To throw the build away and start fresh, use
              Rebuild instead.)
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

      <Dialog
        open={rebuildTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRebuildTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rebuild {rebuildTarget?.ticketKey ?? "ticket"} from scratch?</DialogTitle>
            <DialogDescription>
              Foreman DISCARDS the current build and starts a fresh pass from scratch. This is
              different from Rework: Rework keeps the existing build and layers your guidance on top,
              while Rebuild throws it away and starts over. Your earlier guidance is not carried
              across.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRebuildTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={rebuild.isPending}
              onClick={() => {
                if (!rebuildTarget) return;
                rebuild.mutate(rebuildTarget.workItemId);
                setRebuildTarget(null);
              }}
            >
              <RefreshCw className="size-3.5" /> Rebuild from scratch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={approveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Approve {approveTarget?.ticketKey ?? "this ticket"} and deploy to live production?
            </DialogTitle>
            <DialogDescription>
              On its next pass (≤1 min), Foreman merges the draft PR to main, tags the version, waits
              for the signed CI image, and DEPLOYS it to live production (health-gated, with
              automatic rollback). This ships to real users.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={approve.isPending}
              onClick={() => {
                if (!approveTarget) return;
                approve.mutate({ workItemId: approveTarget.workItemId, projectId: approveTarget.projectId });
                setApproveTarget(null);
              }}
            >
              <Check className="size-3.5" /> Approve &amp; deploy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ForemanEventFeed orgId={orgId} />
    </div>
    </TooltipProvider>
  );
}
