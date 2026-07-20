"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * Foreman's build-harness settings card — a sibling of ForemanSupervisorPanel.
 * GET the org's config (or the safe defaults) on mount, edit locally, PUT the
 * full object back on Save against /api/v1/orgs/:orgId/foreman/harness. THIN: no
 * partial-field PATCHes, no per-field auto-save — mirrors the supervisor form's
 * Save pattern.
 */
interface HarnessSettings {
  enabled: boolean;
  systemPromptAppend: string | null;
}

export function ForemanHarnessPanel({ orgId }: { orgId: string }) {
  return (
    <SectionCard
      icon={Wand2}
      title="Harness settings"
      description="Configure the build harness — the skills, project system prompt, and project MCP tools loaded into every build agent."
    >
      <ForemanHarnessForm orgId={orgId} />
    </SectionCard>
  );
}

function ForemanHarnessForm({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("foreman-harness");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<HarnessSettings>(`/api/v1/orgs/${orgId}/foreman/harness`),
  });
  const qc = useQueryClient();

  const [enabled, setEnabled] = useState(true);
  const [systemPromptAppend, setSystemPromptAppend] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the form once the config loads — idiomatic "hydrate local state from a
  // fetched value" (same idiom as ForemanSupervisorPanel).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setSystemPromptAppend(data.systemPromptAppend);
    }
  }, [data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) {
    return <LoadError title="Couldn't load harness settings" onRetry={() => refetch()} />;
  }

  async function save() {
    const payload: HarnessSettings = { enabled, systemPromptAppend };
    setSaving(true);
    try {
      const saved = await jsonFetch<HarnessSettings>(`/api/v1/orgs/${orgId}/foreman/harness`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      qc.setQueryData<HarnessSettings>(queryKey, saved);
      toast.success("Harness settings saved.");
    } catch (err) {
      notifyError(err, "Couldn't save harness settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
          <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <p className="ml-6 text-xs text-[var(--text-muted)]">
          When enabled, every build agent loads the project skills, the project system prompt,
          and the project MCP tools.
        </p>
      </div>

      <div>
        <label
          htmlFor="harness-system-prompt-append"
          className="mb-1 block text-xs font-medium text-[var(--text-muted)]"
        >
          System-prompt append
        </label>
        <Textarea
          id="harness-system-prompt-append"
          value={systemPromptAppend ?? ""}
          onChange={(e) => setSystemPromptAppend(e.target.value.length === 0 ? null : e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder="Extra instructions appended to every build agent's system prompt for this org…"
          className="w-full"
        />
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          The append is extra system-prompt text for this org&apos;s builds.
        </p>
      </div>

      <div>
        <Button onClick={save} disabled={saving} size="sm">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
