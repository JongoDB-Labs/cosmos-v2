"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Wand2, Info } from "lucide-react";

interface Config {
  enabled: boolean;
  targetProjectId: string | null;
  projects: { id: string; key: string; name: string }[];
}

const NONE = "__none__";

/**
 * Configure the auto-remediation loop (FR 695aa097): a toggle + a target-project
 * picker, plus a "Run now" that triggers a delivery pass immediately. Reads/writes
 * Organization.settings.autoRemediation via the config endpoint.
 */
export function FeedbackAutomationForm({ orgId }: { orgId: string }) {
  const cfgKey = useOrgQueryKey("feedback-remediation-config");
  const { data, isLoading } = useQuery({
    queryKey: cfgKey,
    queryFn: () => jsonFetch<Config>(`/api/v1/orgs/${orgId}/feedback/remediation-config`),
  });

  const [enabled, setEnabled] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState<string>(NONE);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  // Seed the form once the config loads. Idiomatic "hydrate local state from a
  // fetched value" — the effect fires only when `data` changes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setTargetProjectId(data.targetProjectId ?? NONE);
    }
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const projects = data?.projects ?? [];

  async function save() {
    if (enabled && targetProjectId === NONE) {
      toast.error("Pick a target project before enabling.");
      return;
    }
    setSaving(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/feedback/remediation-config`, {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          targetProjectId: targetProjectId === NONE ? null : targetProjectId,
        }),
      });
      toast.success("Feedback automation saved");
    } catch (err) {
      notifyError(err, "Couldn't save the configuration.");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const res = await jsonFetch<{ delivered: number; scanned: number; skipped?: string }>(
        `/api/v1/orgs/${orgId}/feedback/remediate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (res.skipped) {
        toast.message("Nothing delivered", {
          description:
            res.skipped === "not-enabled"
              ? "Enable automation and choose a target project first."
              : `Skipped: ${res.skipped}`,
        });
      } else {
        toast.success(`Delivered ${res.delivered} of ${res.scanned} scanned feedback item(s)`);
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
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 font-medium text-[var(--text)]">
              <Wand2 className="size-4 text-[var(--primary)]" /> Auto-triage feedback
            </div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              When on, new feature requests and bug reports are AI-classified
              (type, severity, effort, acceptance criteria) and delivered into the
              target project&apos;s backlog as work items — so nothing sits in the
              inbox waiting to be actioned.
            </p>
          </div>
          <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable auto-triage" />
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Target project
          </label>
          <Select
            value={targetProjectId}
            onValueChange={(v) => v && setTargetProjectId(v as string)}
          >
            <SelectTrigger size="sm" aria-label="Target project" className="w-full max-w-sm text-sm">
              <SelectValue placeholder="Choose a project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>— none —</SelectItem>
              {projects.map((p) => (
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
          <Button onClick={runNow} disabled={running} variant="outline" size="sm">
            {running ? "Running…" : "Run now"}
          </Button>
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
