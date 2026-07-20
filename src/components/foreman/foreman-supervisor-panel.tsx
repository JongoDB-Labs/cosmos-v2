"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";

/**
 * Foreman's outcome-grooming "supervisor" settings card — a sibling of
 * ForemanGithubPanel. GET the org's config (or the safe defaults) on mount,
 * edit locally, PUT the full object back on Save against
 * /api/v1/orgs/:orgId/foreman/supervisor. THIN: no partial-field PATCHes, no
 * per-field auto-save — mirrors the feedback-automation-form Save pattern.
 */
type SupervisorMode = "off" | "dry" | "live";

interface SupervisorSettings {
  mode: SupervisorMode;
  deliverClose: boolean;
  requeue: boolean;
  dedup: boolean;
  escalate: boolean;
  confidenceThreshold: number;
  perPassCap: number;
}

const MODES: { value: SupervisorMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "dry", label: "Dry" },
  { value: "live", label: "Live" },
];

export function ForemanSupervisorPanel({ orgId }: { orgId: string }) {
  return (
    <SectionCard
      icon={SlidersHorizontal}
      title="Supervisor settings"
      description="Configure Foreman's self-grooming supervisor — how it re-checks parked, stuck, and duplicate tickets between passes."
    >
      <ForemanSupervisorForm orgId={orgId} />
    </SectionCard>
  );
}

function ForemanSupervisorForm({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("foreman-supervisor");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<SupervisorSettings>(`/api/v1/orgs/${orgId}/foreman/supervisor`),
  });
  const qc = useQueryClient();

  const [mode, setMode] = useState<SupervisorMode>("dry");
  const [deliverClose, setDeliverClose] = useState(true);
  const [requeue, setRequeue] = useState(true);
  const [dedup, setDedup] = useState(true);
  const [escalate, setEscalate] = useState(true);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.8);
  const [perPassCap, setPerPassCap] = useState(5);
  const [saving, setSaving] = useState(false);

  // Seed the form once the config loads — idiomatic "hydrate local state from
  // a fetched value" (same idiom as FeedbackAutomationForm).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (data) {
      setMode(data.mode);
      setDeliverClose(data.deliverClose);
      setRequeue(data.requeue);
      setDedup(data.dedup);
      setEscalate(data.escalate);
      setConfidenceThreshold(data.confidenceThreshold);
      setPerPassCap(data.perPassCap);
    }
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) {
    return <LoadError title="Couldn't load supervisor settings" onRetry={() => refetch()} />;
  }

  async function save() {
    const payload: SupervisorSettings = {
      mode,
      deliverClose,
      requeue,
      dedup,
      escalate,
      confidenceThreshold,
      perPassCap,
    };
    setSaving(true);
    try {
      const saved = await jsonFetch<SupervisorSettings>(
        `/api/v1/orgs/${orgId}/foreman/supervisor`,
        { method: "PUT", body: JSON.stringify(payload) },
      );
      qc.setQueryData<SupervisorSettings>(queryKey, saved);
      toast.success("Supervisor settings saved.");
    } catch (err) {
      notifyError(err, "Couldn't save supervisor settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Mode</label>
        <div className="flex items-center gap-2">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              aria-pressed={mode === m.value}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                mode === m.value
                  ? "border-[var(--primary)] bg-[var(--primary-tint)] text-[var(--primary)] font-medium"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--primary-tint)]",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Off = the supervisor ignores this org. Dry = it evaluates parked tickets and proposes
          actions in the activity feed but changes nothing (Apply the ones you want). Live = it
          acts autonomously within the limits below.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Behaviors</label>
        <div className="space-y-2">
          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
              <Checkbox
                checked={deliverClose}
                onChange={(e) => setDeliverClose(e.target.checked)}
              />
              Deliver &amp; close
            </label>
            <p className="ml-6 text-xs text-[var(--text-muted)]">
              Close a draft whose ticket is already delivered on main via other work, and mark it
              done.
            </p>
          </div>
          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
              <Checkbox checked={requeue} onChange={(e) => setRequeue(e.target.checked)} />
              Requeue
            </label>
            <p className="ml-6 text-xs text-[var(--text-muted)]">
              Rebuild a ticket that parked on a since-fixed transient issue (fresh build against
              current main).
            </p>
          </div>
          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
              <Checkbox checked={dedup} onChange={(e) => setDedup(e.target.checked)} />
              Dedup
            </label>
            <p className="ml-6 text-xs text-[var(--text-muted)]">
              Consolidate a ticket that duplicates another — close the draft and link to the
              original.
            </p>
          </div>
          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
              <Checkbox checked={escalate} onChange={(e) => setEscalate(e.target.checked)} />
              Escalate
            </label>
            <p className="ml-6 text-xs text-[var(--text-muted)]">
              Surface uncertain cases to a human with a comment. Never acts on its own — the safe
              catch-all.
            </p>
          </div>
        </div>
      </div>

      <details className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
        <summary className="cursor-pointer font-medium text-[var(--text)]">Advanced</summary>
        <div className="mt-3 flex flex-wrap gap-4">
          <div>
            <label
              htmlFor="supervisor-confidence-threshold"
              className="mb-1 block text-xs font-medium text-[var(--text-muted)]"
            >
              Confidence threshold
            </label>
            <Input
              id="supervisor-confidence-threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={confidenceThreshold}
              onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
              className="w-28"
            />
            <p className="mt-1 max-w-56 text-xs text-[var(--text-muted)]">
              Minimum confidence (0–1) to auto-act on close/dedup. Below it, the supervisor
              escalates instead. Higher = more cautious.
            </p>
          </div>
          <div>
            <label
              htmlFor="supervisor-per-pass-cap"
              className="mb-1 block text-xs font-medium text-[var(--text-muted)]"
            >
              Max actions per pass
            </label>
            <Input
              id="supervisor-per-pass-cap"
              type="number"
              min={1}
              max={50}
              step={1}
              value={perPassCap}
              onChange={(e) => setPerPassCap(Number(e.target.value))}
              className="w-28"
            />
            <p className="mt-1 max-w-56 text-xs text-[var(--text-muted)]">
              Max autonomous changes per pass — a safety limit so one bad pass can&apos;t
              mass-change the board. Escalations don&apos;t count.
            </p>
          </div>
        </div>
      </details>

      <div>
        <Button onClick={save} disabled={saving} size="sm">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
