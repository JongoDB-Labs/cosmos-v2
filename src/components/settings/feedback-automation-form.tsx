"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { type AutomationConfig, validateEnableGate } from "@/lib/feedback/automation-config";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Wand2, Info, Bot } from "lucide-react";

interface ProjectOption {
  id: string;
  key: string;
  name: string;
}

interface Config extends AutomationConfig {
  projects: ProjectOption[];
  aiConnected: boolean;
  aiProvider: string;
  claudeSubscription: { connected: boolean; email?: string | null };
}

const NONE = "__none__";

/**
 * Configure the org's feedback-automation loops (FR 695aa097): auto-triage
 * (multi-project, with a default project for unrouted feedback) and
 * autonomous delivery (multi-project). Reads/writes
 * Organization.settings.{autoRemediation,autonomousDelivery} via the config
 * endpoint — every save/toggle round-trips BOTH blocks in one PUT, so the
 * two cards below never drift into inconsistent partial state.
 */
export function FeedbackAutomationForm({ orgId }: { orgId: string }) {
  const cfgKey = useOrgQueryKey("feedback-remediation-config");
  const { data, isLoading } = useQuery({
    queryKey: cfgKey,
    queryFn: () => jsonFetch<Config>(`/api/v1/orgs/${orgId}/feedback/remediation-config`),
  });

  const [triageEnabled, setTriageEnabled] = useState(false);
  const [triageProjectIds, setTriageProjectIds] = useState<string[]>([]);
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [deliveryProjectIds, setDeliveryProjectIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [savingDelivery, setSavingDelivery] = useState(false);

  // Seed the form once the config loads. Idiomatic "hydrate local state from a
  // fetched value" — the effect fires only when `data` changes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (data) {
      setTriageEnabled(data.autoRemediation.enabled);
      setTriageProjectIds(data.autoRemediation.projectIds);
      setDefaultProjectId(data.autoRemediation.defaultProjectId);
      setDeliveryEnabled(data.autonomousDelivery.enabled);
      setDeliveryProjectIds(data.autonomousDelivery.projectIds);
    }
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const projects = data?.projects ?? [];
  const aiConnected = data?.aiConnected ?? false;
  const defaultProjectOptions = projects.filter((p) => triageProjectIds.includes(p.id));

  function toggleTriageProject(id: string) {
    const next = triageProjectIds.includes(id)
      ? triageProjectIds.filter((p) => p !== id)
      : [...triageProjectIds, id];
    setTriageProjectIds(next);
    // The default must always be one of the checked projects — if unchecking
    // just dropped it out of scope, clear it rather than leave a dangling
    // reference the enable-gate would otherwise reject on save.
    if (defaultProjectId && !next.includes(defaultProjectId)) {
      setDefaultProjectId(null);
    }
  }

  // Build the full config payload (both blocks) from live form state — every
  // delivery write also carries the current triage state, so an unsaved triage
  // edit isn't clobbered by a delivery-side save.
  function deliveryConfig(enabled: boolean, projectIds: string[]): AutomationConfig {
    return {
      autoRemediation: { enabled: triageEnabled, projectIds: triageProjectIds, defaultProjectId },
      autonomousDelivery: { enabled, projectIds },
    };
  }
  async function persistDelivery(config: AutomationConfig): Promise<boolean> {
    setSavingDelivery(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/feedback/remediation-config`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
      return true;
    } catch (err) {
      notifyError(err, "Couldn't update autonomous delivery.");
      return false;
    } finally {
      setSavingDelivery(false);
    }
  }

  // The delivery card persists immediately — same UX as its master switch — so
  // checking/unchecking a project STICKS without a separate Save button (the bug
  // was that this only mutated local state, which a refetch then reverted).
  // Gate-checked first (no flicker on a blocked change), optimistic, reverted on
  // a network failure.
  async function toggleDeliveryProject(id: string) {
    const nextIds = deliveryProjectIds.includes(id)
      ? deliveryProjectIds.filter((p) => p !== id)
      : [...deliveryProjectIds, id];
    const config = deliveryConfig(deliveryEnabled, nextIds);
    const gateReason = validateEnableGate(config);
    if (gateReason) {
      toast.error(gateReason);
      return;
    }
    const previous = deliveryProjectIds;
    setDeliveryProjectIds(nextIds);
    if (!(await persistDelivery(config))) setDeliveryProjectIds(previous);
  }

  async function save() {
    const config: AutomationConfig = {
      autoRemediation: { enabled: triageEnabled, projectIds: triageProjectIds, defaultProjectId },
      autonomousDelivery: { enabled: deliveryEnabled, projectIds: deliveryProjectIds },
    };
    const gateReason = validateEnableGate(config);
    if (gateReason) {
      toast.error(gateReason);
      return;
    }
    setSaving(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/feedback/remediation-config`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
      toast.success("Feedback automation saved");
    } catch (err) {
      notifyError(err, "Couldn't save the configuration.");
    } finally {
      setSaving(false);
    }
  }

  // Master switch persists the instant it's flipped (same helper as the project
  // checklist above). Gate-checked BEFORE the flip lands, so a blocked toggle
  // never visually moves; reverted on a network failure.
  async function toggleDelivery(next: boolean) {
    const config = deliveryConfig(next, deliveryProjectIds);
    const gateReason = validateEnableGate(config);
    if (gateReason) {
      toast.error(gateReason);
      return;
    }
    const previous = deliveryEnabled;
    setDeliveryEnabled(next);
    if (await persistDelivery(config)) {
      toast.success(next ? "Autonomous delivery enabled" : "Autonomous delivery disabled");
    } else {
      setDeliveryEnabled(previous);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const res = await jsonFetch<{
        delivered: number;
        scanned: number;
        skipped?: string;
        skippedNoTarget: number;
      }>(`/api/v1/orgs/${orgId}/feedback/remediate`, { method: "POST", body: JSON.stringify({}) });
      if (res.skipped) {
        toast.message("Nothing delivered", {
          description:
            res.skipped === "not-enabled"
              ? "Enable auto-triage and select at least one project first."
              : res.skipped === "no-ai-credential"
                ? "Connect a Claude subscription in Settings → AI first — triage won't run on a heuristic guess."
                : `Skipped: ${res.skipped}`,
        });
      } else {
        toast.success(
          res.skippedNoTarget > 0
            ? `Delivered ${res.delivered} of ${res.scanned} scanned (${res.skippedNoTarget} skipped — no target project)`
            : `Delivered ${res.delivered} of ${res.scanned} scanned feedback item(s)`,
        );
      }
    } catch (err) {
      notifyError(err, "Couldn't run the remediation pass.");
    } finally {
      setRunning(false);
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* AI-connection gate: the loop only runs with a connected model provider,
          so triage is real AI (Opus 4.8 via a Claude subscription), never a
          low-signal heuristic guess. */}
      {!aiConnected && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              Connect a Claude subscription to activate auto-triage
            </p>
            <p className="text-[var(--text-muted)]">
              This runs on your own Claude account. Until a Claude subscription (or
              model key) is connected in{" "}
              <a href="../ai" className="underline">
                Settings → AI
              </a>
              , the automation stays inert — it won&apos;t deliver on a heuristic guess.
            </p>
          </div>
        </div>
      )}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 font-medium text-[var(--text)]">
              <Wand2 className="size-4 text-[var(--primary)]" /> Auto-triage feedback
            </div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              When on, every feature request and bug report in this org — wherever
              in the app it was reported — is AI-classified (type, severity, effort,
              acceptance criteria) and filed as a work item into the board it belongs
              to. Pick the board(s) that should receive triaged feedback, plus a
              default board for anything unmatched — point both at a single board to
              funnel all of this org&apos;s feedback there.
            </p>
          </div>
          <ToggleSwitch
            checked={triageEnabled}
            onCheckedChange={setTriageEnabled}
            aria-label="Enable auto-triage"
          />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Projects
          </label>
          <ProjectChecklist
            projects={projects}
            selectedIds={triageProjectIds}
            onToggle={toggleTriageProject}
            ariaLabel="Projects to receive triaged feedback"
          />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Default project for unrouted feedback
          </label>
          <Select
            value={defaultProjectId ?? NONE}
            onValueChange={(v) => setDefaultProjectId(v === NONE ? null : v)}
          >
            <SelectTrigger
              size="sm"
              aria-label="Default project for unrouted feedback"
              className="w-full max-w-sm text-sm"
            >
              <SelectValue placeholder="Choose a default project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>— none —</SelectItem>
              {defaultProjectOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.key} · {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            onClick={runNow}
            disabled={running || !aiConnected}
            variant="outline"
            size="sm"
            title={aiConnected ? undefined : "Connect a Claude subscription in Settings → AI first"}
          >
            {running ? "Running…" : "Run now"}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 font-medium text-[var(--text)]">
              <Bot className="size-4 text-[var(--primary)]" /> Autonomous delivery
              <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Owner
              </span>
            </div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Owner capability — a worker implements, tests, and ships the
              product&apos;s own code from the selected backlog(s); safe changes
              deploy, risky ones wait for your approval. This isn&apos;t a per-team
              setting — it&apos;s scoped per org here for now, and moves to a
              platform-admin control as multi-tenant support matures.
            </p>
          </div>
          <ToggleSwitch
            checked={deliveryEnabled}
            onCheckedChange={toggleDelivery}
            disabled={savingDelivery || !aiConnected}
            aria-label="Enable autonomous delivery"
          />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Projects
          </label>
          <ProjectChecklist
            projects={projects}
            selectedIds={deliveryProjectIds}
            onToggle={toggleDeliveryProject}
            ariaLabel="Projects for autonomous delivery"
          />
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            These projects&apos; backlogs are implemented &amp; shipped as cosmos-v2 code changes.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 p-4 text-xs text-[var(--text-muted)]">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p>
            A scheduled job runs this automatically (see the
            {" "}
            <code>feedback-remediation</code> GitHub Action). Each item is
            delivered exactly once; re-runs never duplicate.
          </p>
          <p>
            Delivery creates a tracked work item — it never edits code or merges
            anything. Drafting an actual fix stays a downstream, human-approved
            step.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Shared checklist body for both cards' project multi-selects — one row per
 *  org project, `{key} · {name}`, backed by the existing Checkbox primitive. */
function ProjectChecklist({
  projects,
  selectedIds,
  onToggle,
  ariaLabel,
}: {
  projects: ProjectOption[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  ariaLabel: string;
}) {
  if (projects.length === 0) {
    return (
      <p className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)]">
        No projects yet.
      </p>
    );
  }
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="max-h-48 divide-y divide-[var(--border)] overflow-y-auto rounded-md border border-[var(--border)]"
    >
      {projects.map((p) => (
        <label
          key={p.id}
          className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--muted)]/30"
        >
          <Checkbox checked={selectedIds.includes(p.id)} onChange={() => onToggle(p.id)} />
          <span>
            {p.key} · {p.name}
          </span>
        </label>
      ))}
    </div>
  );
}
